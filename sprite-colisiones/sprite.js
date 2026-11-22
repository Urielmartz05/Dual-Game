// Demo de sprite sheet: parado, caminando, corriendo y brincando
// con fondo en parallax y detección de colisiones contra obstáculos.

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const W = canvas.width;
const H = canvas.height;

// ---------------------------------------------------------------------------
// Sprite sheets:
//   Jugador 1: New Sprite.png (8 frames en una fila, pixel art)
//   Jugador 2: player2.png (5 columnas x 4 filas)
// ---------------------------------------------------------------------------
const STRIP_P1 = [
    [1, 1, 99, 136],    // 0: idle
    [159, 1, 98, 135],  // 1: idle
    [317, 1, 98, 136],  // 2: idle
    [474, 1, 99, 135],  // 3: idle
    [633, 1, 98, 136],  // 4: idle / transición
    [791, 1, 98, 136],  // 5: paso 1
    [949, 1, 98, 137],  // 6: paso 2
    [1106, 1, 98, 136]  // 7: paso 3
];

function buildP1Frames() {
    const raw = {
        idle: [STRIP_P1[0], STRIP_P1[1], STRIP_P1[2], STRIP_P1[3], STRIP_P1[4]],
        walk: [STRIP_P1[4], STRIP_P1[5], STRIP_P1[6], STRIP_P1[7], STRIP_P1[6]],
        run:  [STRIP_P1[5], STRIP_P1[6], STRIP_P1[7], STRIP_P1[6]],
        jump: [STRIP_P1[4], STRIP_P1[5], STRIP_P1[7], STRIP_P1[6], STRIP_P1[4]]
    };
    const out = {};
    for (const name in raw) {
        out[name] = raw[name].map(f => ({
            sx: f[0], sy: f[1], sw: f[2], sh: f[3],
            ax: f[2] / 2,
            ay: f[3]
        }));
    }
    return out;
}

function buildP2Frames() {
    const cellW = 409 / 5;
    const raw = {
        idle: [[18, 22, 52, 104], [98, 22, 51, 104], [179, 22, 52, 104], [260, 22, 52, 104], [341, 22, 52, 104]],
        walk: [[22, 161, 49, 108], [100, 161, 51, 108], [177, 161, 54, 106], [257, 161, 53, 106], [333, 162, 58, 105]],
        run:  [[19, 307, 65, 100], [96, 307, 65, 101], [175, 307, 67, 100], [252, 307, 66, 97], [328, 308, 69, 98]],
        jump: [[19, 474, 57, 109], [98, 456, 57, 111], [177, 430, 57, 112], [251, 459, 61, 110], [326, 493, 62, 101]]
    };
    const out = {};
    for (const name in raw) {
        const baseline = Math.max(...raw[name].map(f => f[1] + f[3]));
        out[name] = raw[name].map((f, i) => ({
            sx: f[0], sy: f[1], sw: f[2], sh: f[3],
            ax: cellW * i + cellW / 2 - f[0],
            ay: name === 'jump' ? f[3] : baseline - f[1]
        }));
    }
    return out;
}

function loadSprite(src, frames, scale, smooth) {
    const img = new Image();
    const s = { img, ready: false, frames, scale, smooth };
    img.onload = () => { s.ready = true; };
    img.src = src;
    return s;
}

const SPRITES = {
    1: loadSprite('New Sprite.png', buildP1Frames(), 0.72, false),
    2: loadSprite('player2.png', buildP2Frames(), 1, true)
};

let mySlot = 1;
function mySprite() { return SPRITES[mySlot] || SPRITES[1]; }

// ---------------------------------------------------------------------------
// Constantes de física
// ---------------------------------------------------------------------------
const GROUND_Y = 380;        // y del suelo (donde pisan los pies)
const PLAYER_SCREEN_X = 260; // posición fija del personaje en pantalla
const WALK_SPEED = 170;
const RUN_SPEED = 360;
const GRAVITY = 2000;
const JUMP_VELOCITY = -700;  // altura máx. ≈ 122 px (obstáculos miden 30–75)
const HIT_W = 38;            // hitbox del personaje (más chica que el dibujo)
const HIT_H = 88;

const player = {
    x: 0,                    // posición en el mundo (centro)
    y: GROUND_Y,             // y de los pies
    vx: 0,
    vy: 0,
    grounded: true,
    facing: 1,               // 1 derecha, -1 izquierda
    state: 'idle',
    frame: 0,
    frameTime: 0,
    jumpTime: 0,             // tiempo desde que despegó
    landTimer: 0,            // muestra el frame de aterrizaje un instante
    blocked: false
};

let showHitboxes = false;
let collisions = 0;
let lastCollisionTime = -10;
let time = 0;
let gameOver = false;
let gameOverInfo = null;

function resetMatch() {
    gameOver = false;
    gameOverInfo = null;
    collisions = 0;
    lastCollisionTime = -10;
    obstacleCache.clear();
    player.x = 0;
    player.y = GROUND_Y;
    player.vx = 0;
    player.vy = 0;
    player.grounded = true;
    player.facing = 1;
    player.state = 'idle';
    player.frame = 0;
    player.frameTime = 0;
    player.jumpTime = 0;
    player.landTimer = 0;
    player.blocked = false;
    for (const rp of remotePlayers.values()) {
        rp.x = 0;
        rp.y = GROUND_Y;
        rp.facing = 1;
        rp.state = 'idle';
        rp.frame = 0;
    }
}

// ---------------------------------------------------------------------------
// Socket.IO opcional (sincroniza jugadores en vivo cuando se sirve desde server.js)
// ---------------------------------------------------------------------------
const remotePlayers = new Map();
let spriteSocket = null;
let mySocketId = null;
let lastNetSend = 0;
let roomFull = false;

if (typeof io !== 'undefined') {
    spriteSocket = io('/sprite');
    spriteSocket.on('sprite_full', () => {
        roomFull = true;
    });
    spriteSocket.on('sprite_init', ({ id, slot, players }) => {
        mySocketId = id;
        mySlot = slot || 1;
        remotePlayers.clear();
        for (const p of players) {
            if (p.id !== mySocketId) remotePlayers.set(p.id, p);
        }
    });
    spriteSocket.on('sprite_joined', (p) => {
        if (p && p.id && p.id !== mySocketId) remotePlayers.set(p.id, p);
    });
    spriteSocket.on('sprite_moved', (p) => {
        if (p && p.id && p.id !== mySocketId) remotePlayers.set(p.id, p);
    });
    spriteSocket.on('sprite_left', ({ id }) => {
        remotePlayers.delete(id);
    });
    spriteSocket.on('sprite_gameover', (info) => {
        gameOver = true;
        gameOverInfo = info;
    });
    spriteSocket.on('sprite_restart', () => {
        resetMatch();
    });
}

// ---------------------------------------------------------------------------
// Teclado
// ---------------------------------------------------------------------------
const keys = {};
const GAME_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space',
                   'KeyA', 'KeyD', 'KeyW', 'ShiftLeft', 'ShiftRight'];

window.addEventListener('keydown', e => {
    if (GAME_KEYS.includes(e.code)) e.preventDefault();
    if (e.code === 'KeyH' && !e.repeat) showHitboxes = !showHitboxes;
    if ((e.code === 'KeyR' || e.key === 'r' || e.key === 'R') && !e.repeat && !e.ctrlKey && !e.metaKey) {
        resetMatch();
        if (spriteSocket && spriteSocket.connected) spriteSocket.emit('sprite_restart');
    }
    keys[e.code] = true;
});
window.addEventListener('keyup', e => { keys[e.code] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

// ---------------------------------------------------------------------------
// Mundo: obstáculos generados de forma determinista por "chunks",
// así existen igual si el personaje camina hacia adelante o hacia atrás.
// ---------------------------------------------------------------------------
const CHUNK = 380;
const obstacleCache = new Map();

function hash(n) {
    let h = Math.imul(n | 0, 0x45d9f3b) ^ 0x1b873593;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function obstacleForChunk(i) {
    if (obstacleCache.has(i)) return obstacleCache.get(i);
    let o = null;
    if (i >= 1 && hash(i * 7 + 1) < 0.8) {            // el chunk 0 queda libre (zona de inicio)
        const type = hash(i * 7 + 2) < 0.5 ? 'rock' : 'crate';
        o = {
            type,
            x: i * CHUNK + 120 + hash(i * 7 + 3) * 140,
            w: type === 'crate' ? 48 + Math.floor(hash(i * 7 + 4) * 2) * 24 : 44 + hash(i * 7 + 4) * 30,
            h: 30 + hash(i * 7 + 5) * 45,
            hit: false
        };
        if (type === 'crate') o.h = o.w;                // las cajas son cuadradas
        o.h = Math.min(o.h, 75);
    }
    obstacleCache.set(i, o);
    return o;
}

function visibleObstacles(camX) {
    const list = [];
    const first = Math.floor((camX - 100) / CHUNK);
    const last = Math.floor((camX + W + 100) / CHUNK);
    for (let i = first; i <= last; i++) {
        const o = obstacleForChunk(i);
        if (o) list.push(o);
    }
    return list;
}

// ---------------------------------------------------------------------------
// Colisiones (AABB)
// Hitbox del jugador: centro x, pies y. Obstáculo: x, w, h apoyado en el suelo.
// ---------------------------------------------------------------------------
function overlaps(px, py, o) {
    const top = GROUND_Y - o.h;
    return px + HIT_W / 2 > o.x && px - HIT_W / 2 < o.x + o.w &&
           py > top && py - HIT_H < GROUND_Y;
}

function registerHit(o) {
    player.blocked = true;
    lastCollisionTime = time;
    if (!o.hit) { o.hit = true; collisions++; }
    if (!gameOver) {
        gameOver = true;
        gameOverInfo = { loserSlot: mySlot, winnerSlot: mySlot === 1 ? 2 : 1 };
        if (spriteSocket && spriteSocket.connected) {
            spriteSocket.emit('sprite_hit');
        }
    }
}

// ---------------------------------------------------------------------------
// Actualización
// ---------------------------------------------------------------------------
function update(dt) {
    time += dt;
    if (gameOver) return;

    const left = keys.ArrowLeft || keys.KeyA;
    const right = keys.ArrowRight || keys.KeyD;
    const run = keys.ShiftLeft || keys.ShiftRight;
    const jumpKey = keys.Space || keys.ArrowUp || keys.KeyW;
    const dir = (right ? 1 : 0) - (left ? 1 : 0);

    // --- Movimiento horizontal (con una pequeña aceleración) ---
    const targetSpeed = dir * (run ? RUN_SPEED : WALK_SPEED);
    const accel = player.grounded ? 2400 : 1500;
    if (player.vx < targetSpeed) player.vx = Math.min(targetSpeed, player.vx + accel * dt);
    else if (player.vx > targetSpeed) player.vx = Math.max(targetSpeed, player.vx - accel * dt);
    if (dir !== 0) player.facing = dir;

    // --- Salto ---
    if (jumpKey && player.grounded) {
        player.vy = JUMP_VELOCITY;
        player.grounded = false;
        player.jumpTime = 0;
    }
    if (!jumpKey && player.vy < -250 && !player.grounded) player.vy = -250; // soltar = salto corto

    player.blocked = false;
    const obstacles = visibleObstacles(player.x - PLAYER_SCREEN_X);

    // --- Eje X: mover y empujar fuera si choca de lado ---
    player.x += player.vx * dt;
    for (const o of obstacles) {
        if (overlaps(player.x, player.y, o)) {
            if (player.vx > 0 || (player.vx === 0 && player.x < o.x + o.w / 2)) {
                player.x = o.x - HIT_W / 2;
            } else {
                player.x = o.x + o.w + HIT_W / 2;
            }
            player.vx = 0;
            registerHit(o);
        }
    }

    // --- Eje Y: gravedad, aterrizar sobre suelo u obstáculos ---
    const prevY = player.y;
    player.vy += GRAVITY * dt;
    player.y += player.vy * dt;
    if (!player.grounded) player.jumpTime += dt;

    let landedOn = null;
    if (player.vy >= 0) {
        for (const o of obstacles) {
            const top = GROUND_Y - o.h;
            const overX = player.x + HIT_W / 2 > o.x && player.x - HIT_W / 2 < o.x + o.w;
            if (overX && prevY <= top + 0.5 && player.y >= top) landedOn = top;
        }
    }
    let floorY = landedOn !== null ? landedOn : GROUND_Y;
    if (player.y >= floorY) {
        if (!player.grounded && player.vy > 200) player.landTimer = 0.1;
        player.y = floorY;
        player.vy = 0;
        player.grounded = true;
    } else {
        player.grounded = false;
    }

    // Si estaba parado sobre algo y se salió del borde, cae
    if (player.grounded && player.y < GROUND_Y) {
        const supported = obstacles.some(o =>
            Math.abs(player.y - (GROUND_Y - o.h)) < 0.5 &&
            player.x + HIT_W / 2 > o.x && player.x - HIT_W / 2 < o.x + o.w);
        if (!supported) player.grounded = false;
    }

    if (player.landTimer > 0) player.landTimer -= dt;

    // --- Estado y animación ---
    const speed = Math.abs(player.vx);
    const intending = dir !== 0;
    if (!player.grounded) player.state = 'jump';
    else if (intending && run) player.state = 'run';
    else if (intending) player.state = 'walk';
    else if (speed > 20) player.state = player.vx !== 0 && run ? 'run' : 'walk';
    else player.state = 'idle';

    let fps = { idle: 6, walk: 8, run: 13 }[player.state];
    if (player.state !== 'jump') {
        player.frameTime += dt;
        const step = 1 / fps;
        const totalFrames = mySprite().frames[player.state].length;
        while (player.frameTime >= step) {
            player.frameTime -= step;
            player.frame = (player.frame + 1) % totalFrames;
        }
        if (player.frame >= totalFrames) player.frame = 0;
    }
    if (spriteSocket && spriteSocket.connected && time - lastNetSend >= 0.05) {
        lastNetSend = time;
        spriteSocket.emit('sprite_update', {
            x: player.x,
            y: player.y,
            facing: player.facing,
            state: player.state,
            frame: player.frame,
            collisions
        });
    }
}

// ---------------------------------------------------------------------------
// Fondo con parallax (todo depende de la posición del mundo, así que se mueve
// al caminar/correr y se detiene si el personaje choca).
// ---------------------------------------------------------------------------
function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    g.addColorStop(0, '#5aa9e6');
    g.addColorStop(1, '#cfeaf7');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Sol fijo
    ctx.fillStyle = '#fff3b0';
    ctx.beginPath();
    ctx.arc(660, 80, 34, 0, Math.PI * 2);
    ctx.fill();
}

function drawClouds(camX) {
    const k = 0.1, spacing = 260;
    const off = camX * k;
    const first = Math.floor(off / spacing) - 1;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (let i = first; i <= first + Math.ceil(W / spacing) + 2; i++) {
        const x = i * spacing - off + hash(i * 3) * 120;
        const y = 40 + hash(i * 3 + 1) * 100;
        const s = 0.7 + hash(i * 3 + 2) * 0.7;
        ctx.beginPath();
        ctx.ellipse(x, y, 42 * s, 16 * s, 0, 0, Math.PI * 2);
        ctx.ellipse(x - 26 * s, y + 4 * s, 26 * s, 12 * s, 0, 0, Math.PI * 2);
        ctx.ellipse(x + 28 * s, y + 5 * s, 28 * s, 11 * s, 0, 0, Math.PI * 2);
        ctx.fill();
    }
}

function drawMountains(camX, k, base, amp, color, wavelength) {
    const off = camX * k;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    for (let x = 0; x <= W; x += 8) {
        const wx = x + off;
        const y = base - amp * (0.55 + 0.3 * Math.sin(wx / wavelength) +
                                0.15 * Math.sin(wx / (wavelength * 0.37) + 1.7));
        ctx.lineTo(x, y);
    }
    ctx.lineTo(W, GROUND_Y);
    ctx.closePath();
    ctx.fill();
}

function drawTrees(camX) {
    const k = 0.6, spacing = 150;
    const off = camX * k;
    const first = Math.floor(off / spacing) - 1;
    for (let i = first; i <= first + Math.ceil(W / spacing) + 2; i++) {
        if (hash(i * 5 + 9) < 0.35) continue;
        const x = i * spacing - off + hash(i * 5 + 1) * 60;
        const h = 60 + hash(i * 5 + 2) * 50;
        ctx.fillStyle = '#5b3f2a';
        ctx.fillRect(x - 5, GROUND_Y - h * 0.45, 10, h * 0.45);
        ctx.fillStyle = '#2e7d4f';
        ctx.beginPath();
        ctx.arc(x, GROUND_Y - h * 0.65, h * 0.38, 0, Math.PI * 2);
        ctx.arc(x - h * 0.22, GROUND_Y - h * 0.5, h * 0.27, 0, Math.PI * 2);
        ctx.arc(x + h * 0.22, GROUND_Y - h * 0.5, h * 0.27, 0, Math.PI * 2);
        ctx.fill();
    }
}

function drawGround(camX) {
    ctx.fillStyle = '#6b8e23';
    ctx.fillRect(0, GROUND_Y, W, 12);
    ctx.fillStyle = '#8b6b4a';
    ctx.fillRect(0, GROUND_Y + 12, W, H - GROUND_Y - 12);

    // Franjas / piedritas que se mueven al 100 % con el mundo
    const spacing = 64;
    const first = Math.floor(camX / spacing) - 1;
    for (let i = first; i <= first + Math.ceil(W / spacing) + 2; i++) {
        const x = i * spacing - camX;
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        ctx.fillRect(x, GROUND_Y + 12, 3, H - GROUND_Y);
        ctx.fillStyle = '#7a9a2a';
        ctx.fillRect(x + 20, GROUND_Y + 2, 14, 4);
        ctx.fillStyle = '#6f5338';
        ctx.fillRect(x + 10 + hash(i) * 30, GROUND_Y + 30 + hash(i + 50) * 30, 8, 5);
    }
}

function drawObstacle(o, camX) {
    const x = o.x - camX;
    const y = GROUND_Y - o.h;
    const flash = time - lastCollisionTime < 0.25 && o.hit;
    if (o.type === 'rock') {
        ctx.fillStyle = flash ? '#e74c3c' : '#7f8c8d';
        ctx.beginPath();
        ctx.moveTo(x, GROUND_Y);
        ctx.quadraticCurveTo(x + o.w * 0.05, y + o.h * 0.15, x + o.w * 0.35, y);
        ctx.quadraticCurveTo(x + o.w * 0.8, y - 2, x + o.w, GROUND_Y);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(x + o.w * 0.3, y + 5, o.w * 0.2, 4);
    } else {
        ctx.fillStyle = flash ? '#e74c3c' : '#b8793b';
        ctx.fillRect(x, y, o.w, o.h);
        ctx.strokeStyle = '#6e4519';
        ctx.lineWidth = 3;
        ctx.strokeRect(x + 1.5, y + 1.5, o.w - 3, o.h - 3);
        ctx.beginPath();
        ctx.moveTo(x + 3, y + 3); ctx.lineTo(x + o.w - 3, y + o.h - 3);
        ctx.moveTo(x + o.w - 3, y + 3); ctx.lineTo(x + 3, y + o.h - 3);
        ctx.stroke();
    }
    if (showHitboxes) {
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, o.w, o.h);
    }
}

// ---------------------------------------------------------------------------
// Personaje
// ---------------------------------------------------------------------------
function currentFrame() {
    const frames = mySprite().frames;
    if (player.state === 'jump') {
        let i;
        if (player.jumpTime < 0.06) i = 0;           // agacharse al despegar
        else if (player.vy < -250) i = 1;            // subiendo
        else if (player.vy <= 150) i = 2;            // punto más alto
        else i = 3;                                  // cayendo
        return frames.jump[i];
    }
    if (player.landTimer > 0) return frames.jump[4]; // aterrizaje
    const list = frames[player.state];
    return list[player.frame % list.length];
}

function drawPlayer() {
    const sp = mySprite();
    const f = currentFrame();
    const dx = PLAYER_SCREEN_X;
    const dy = player.y;

    if (sp.ready) {
        ctx.save();
        ctx.translate(dx, dy);
        ctx.scale(player.facing * sp.scale, sp.scale); // el sprite mira a la derecha; se voltea a la izquierda
        ctx.imageSmoothingEnabled = sp.smooth;
        ctx.drawImage(sp.img, f.sx, f.sy, f.sw, f.sh, -f.ax, -f.ay, f.sw, f.sh);
        ctx.restore();
    } else {
        ctx.fillStyle = '#fff';
        ctx.fillRect(dx - HIT_W / 2, dy - HIT_H, HIT_W, HIT_H);
    }

    // Sombra en el suelo (se achica al subir)
    const air = Math.max(0, GROUND_Y - player.y);
    ctx.fillStyle = 'rgba(0,0,0,' + Math.max(0.08, 0.3 - air / 600) + ')';
    ctx.beginPath();
    ctx.ellipse(dx, GROUND_Y + 4, Math.max(8, 26 - air / 8), 5, 0, 0, Math.PI * 2);
    ctx.fill();

    if (showHitboxes) {
        const hitNow = time - lastCollisionTime < 0.25;
        ctx.strokeStyle = hitNow ? '#ff2d2d' : '#00aaff';
        ctx.lineWidth = 2;
        ctx.strokeRect(dx - HIT_W / 2, dy - HIT_H, HIT_W, HIT_H);
    }
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const STATE_LABEL = { idle: 'PARADO', walk: 'CAMINANDO', run: 'CORRIENDO', jump: 'BRINCANDO' };

function drawHUD() {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(10, 10, 210, 78);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText('Estado: ' + STATE_LABEL[player.state], 20, 18);
    ctx.font = '14px sans-serif';
    ctx.fillText('Distancia: ' + Math.max(0, Math.floor(player.x / 10)) + ' m', 20, 42);
    const statusText = roomFull ? 'Sala llena (solo local)' : 'Jugadores: ' + (1 + remotePlayers.size) + '/2';
    ctx.fillText('Choques: ' + collisions + '  |  ' + statusText, 20, 62);

    if (gameOver && gameOverInfo) {
        const iLost = gameOverInfo.loserSlot === mySlot;
        ctx.fillStyle = 'rgba(11, 15, 23, 0.72)';
        ctx.fillRect(0, 0, W, H);

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 42px sans-serif';
        ctx.fillStyle = iLost ? '#ff6b6b' : '#3ddc97';
        ctx.fillText(iLost ? '¡PERDISTE!' : '¡GANASTE!', W / 2, H / 2 - 30);

        ctx.font = '18px sans-serif';
        ctx.fillStyle = '#e8ecf4';
        const sub = iLost
            ? 'Chocaste con un obstáculo · Gana Jugador ' + gameOverInfo.winnerSlot
            : 'Jugador ' + gameOverInfo.loserSlot + ' chocó con un obstáculo';
        ctx.fillText(sub, W / 2, H / 2 + 16);

        ctx.font = '15px sans-serif';
        ctx.fillStyle = '#8d97ab';
        ctx.fillText('Presiona R para volver a jugar', W / 2, H / 2 + 52);
    } else if (time - lastCollisionTime < 0.6) {
        ctx.font = 'bold 28px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#e74c3c';
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 4;
        ctx.strokeText('¡COLISIÓN! Brinca el obstáculo', W / 2, 110);
        ctx.fillText('¡COLISIÓN! Brinca el obstáculo', W / 2, 110);
    }
}

// ---------------------------------------------------------------------------
// Bucle principal
// ---------------------------------------------------------------------------
function drawRemotePlayers(camX) {
    for (const rp of remotePlayers.values()) {
        const dx = rp.x - camX;
        if (dx < -80 || dx > W + 80) continue;
        const sp = SPRITES[rp.slot] || SPRITES[2];
        const frames = sp.frames[rp.state] || sp.frames.idle;
        const f = frames[rp.frame % frames.length] || sp.frames.idle[0];
        ctx.save();
        if (sp.ready) {
            ctx.translate(dx, rp.y);
            ctx.scale((rp.facing || 1) * sp.scale, sp.scale);
            ctx.imageSmoothingEnabled = sp.smooth;
            ctx.drawImage(sp.img, f.sx, f.sy, f.sw, f.sh, -f.ax, -f.ay, f.sw, f.sh);
        } else {
            ctx.fillStyle = '#4aa8ff';
            ctx.fillRect(dx - HIT_W / 2, rp.y - HIT_H, HIT_W, HIT_H);
        }
        ctx.restore();

        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Jugador ' + (rp.slot || 2), dx, rp.y - HIT_H - 12);
    }
}

function draw() {
    const camX = player.x - PLAYER_SCREEN_X;
    drawSky();
    drawClouds(camX);
    drawMountains(camX, 0.2, GROUND_Y - 40, 170, '#8fb3c9', 210);
    drawMountains(camX, 0.4, GROUND_Y - 10, 120, '#5f8f7a', 140);
    drawTrees(camX);
    drawGround(camX);
    for (const o of visibleObstacles(camX)) drawObstacle(o, camX);
    drawRemotePlayers(camX);
    drawPlayer();
    drawHUD();
}

let last = performance.now();
function loop(now) {
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    update(dt);
    draw();
    requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
