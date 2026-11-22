import express from "express";
import http from "http";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { Server } from "socket.io";

import configMod from "./juegos-dual/server/config.js";
import duelMod from "./juegos-dual/server/duel.js";

const { getConfig } = configMod;
const { Duel } = duelMod;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cfg = getConfig();
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PONG_ROOM = "duel";
const PLAYER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const jugadoresSprite = {};

// Rutas HTTP: menú y los dos juegos
app.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/style.css", (_req, res) => {
    res.sendFile(path.join(__dirname, "style.css"));
});

app.use((req, res, next) => {
    if (req.originalUrl === "/pong") return res.redirect(301, "/pong/");
    if (req.originalUrl === "/sprite") return res.redirect(301, "/sprite/");
    next();
});

app.use("/pong", express.static(path.join(__dirname, "juegos-dual", "public")));
app.use("/sprite", express.static(path.join(__dirname, "sprite-colisiones"), { index: "sprite.html" }));

// =========================================================================
// 1) Socket.IO — Pong Dual (namespace "/")
// =========================================================================
const duel = new Duel(cfg, (event, payload, side) => {
    if (event === "kick") {
        const s = io.sockets.sockets.get(payload.socketId);
        if (s) {
            s.emit("kicked", { reason: payload.reason });
            s.disconnect(true);
        }
        return;
    }
    if (side) {
        const slot = duel.slots[side];
        if (slot && slot.connected) io.to(slot.socketId).emit(event, payload);
    } else {
        io.to(PONG_ROOM).emit(event, payload);
    }
});

io.use((socket, next) => {
    const raw = socket.handshake.auth && socket.handshake.auth.playerId;
    const playerId = typeof raw === "string" && PLAYER_ID_RE.test(raw) ? raw : crypto.randomUUID();
    if (!duel.canJoin(playerId)) {
        const err = new Error("duel_full");
        err.data = { message: "Duelo lleno" };
        return next(err);
    }
    socket.data.playerId = playerId;
    next();
});

io.on("connection", (socket) => {
    console.log("Jugador conectado a Pong:", socket.id);

    const res = duel.join(socket.data.playerId, socket.id);
    if (!res.ok) {
        socket.emit("duel_full", { message: "Duelo lleno" });
        socket.disconnect(true);
        return;
    }
    if (res.replacedSocketId) {
        const old = io.sockets.sockets.get(res.replacedSocketId);
        if (old) old.disconnect(true);
    }

    socket.join(PONG_ROOM);
    socket.emit("joined", { side: res.side, playerId: socket.data.playerId });
    socket.emit("phase", duel.phasePayload());

    let windowStart = Date.now();
    let count = 0;

    socket.on("input", (msg) => {
        const now = Date.now();
        if (now - windowStart >= 1000) {
            windowStart = now;
            count = 0;
        }
        if (++count > cfg.INPUT_MAX_PER_SEC) return;
        const side = duel.sideOf(socket.id);
        if (!side || !msg || typeof msg !== "object") return;
        duel.input(side, msg.dir);
    });

    socket.on("ready", () => {
        const side = duel.sideOf(socket.id);
        if (side) duel.ready(side);
    });

    socket.on("rematch", () => {
        const side = duel.sideOf(socket.id);
        if (side) duel.rematch(side);
    });

    socket.on("latency", (ack) => {
        if (typeof ack === "function") ack();
    });

    socket.on("disconnect", () => {
        console.log("Jugador desconectado de Pong:", socket.id);
        duel.leave(socket.id);
    });
});

// Bucle del servidor para Pong Dual
let last = process.hrtime.bigint();
let stateAcc = 0;

setInterval(() => {
    const now = process.hrtime.bigint();
    let dt = Number(now - last) / 1e6;
    last = now;
    if (dt > 100) dt = 100;

    duel.tick(dt);
    stateAcc += dt;

    if (stateAcc >= 1000 / cfg.STATE_RATE) {
        stateAcc %= 1000 / cfg.STATE_RATE;
        const room = io.sockets.adapter.rooms.get(PONG_ROOM);
        if (room && room.size) io.to(PONG_ROOM).emit("state", duel.snapshot());
    }
}, 1000 / cfg.TICK_RATE);

// =========================================================================
// 2) Socket.IO — Sprite Colisiones (namespace "/sprite")
// =========================================================================
const spriteIo = io.of("/sprite");
const MAX_SPRITE_PLAYERS = 2;
let spriteGameOver = false;

spriteIo.on("connection", (socket) => {
    if (Object.keys(jugadoresSprite).length >= MAX_SPRITE_PLAYERS) {
        console.log("Sala Sprite llena, rechazado:", socket.id);
        socket.emit("sprite_full", { message: "Sala llena (máximo 2 jugadores)" });
        socket.disconnect(true);
        return;
    }

    console.log("Jugador conectado a Sprite:", socket.id);

    const ocupados = Object.values(jugadoresSprite).map((j) => j.slot);
    const slot = ocupados.includes(1) ? 2 : 1;

    jugadoresSprite[socket.id] = {
        id: socket.id,
        slot,
        x: 0,
        y: 380,
        facing: 1,
        state: "idle",
        frame: 0,
        collisions: 0,
    };

    socket.emit("sprite_init", {
        id: socket.id,
        slot,
        players: Object.values(jugadoresSprite),
    });
    socket.broadcast.emit("sprite_joined", jugadoresSprite[socket.id]);

    socket.on("sprite_update", (datos) => {
        const jugador = jugadoresSprite[socket.id];
        if (!jugador || !datos || typeof datos !== "object") return;

        if (typeof datos.x === "number" && Number.isFinite(datos.x)) jugador.x = datos.x;
        if (typeof datos.y === "number" && Number.isFinite(datos.y)) jugador.y = datos.y;
        if (datos.facing === 1 || datos.facing === -1) jugador.facing = datos.facing;
        if (typeof datos.state === "string") jugador.state = datos.state;
        if (typeof datos.frame === "number" && Number.isFinite(datos.frame)) jugador.frame = datos.frame;
        if (typeof datos.collisions === "number" && Number.isFinite(datos.collisions)) {
            jugador.collisions = datos.collisions;
        }

        socket.broadcast.emit("sprite_moved", jugador);
    });

    socket.on("sprite_hit", () => {
        const jugador = jugadoresSprite[socket.id];
        if (!jugador || spriteGameOver) return;
        spriteGameOver = true;
        const loserSlot = jugador.slot;
        const winnerSlot = loserSlot === 1 ? 2 : 1;
        spriteIo.emit("sprite_gameover", { loserSlot, winnerSlot });
    });

    socket.on("sprite_restart", () => {
        spriteGameOver = false;
        for (const id in jugadoresSprite) {
            jugadoresSprite[id].x = 0;
            jugadoresSprite[id].y = 380;
            jugadoresSprite[id].facing = 1;
            jugadoresSprite[id].state = "idle";
            jugadoresSprite[id].frame = 0;
            jugadoresSprite[id].collisions = 0;
        }
        spriteIo.emit("sprite_restart");
    });

    socket.on("disconnect", () => {
        console.log("Jugador desconectado de Sprite:", socket.id);
        delete jugadoresSprite[socket.id];
        if (Object.keys(jugadoresSprite).length === 0) spriteGameOver = false;
        socket.broadcast.emit("sprite_left", { id: socket.id });
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Servidor activo en http://localhost:${PORT}`);
});
