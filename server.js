// server.js
// Minimal multiplayer server for Road-Trip Rally
// Run: npm init -y && npm i express socket.io && node server.js
const path = require("path");
const express = require("express");
const http = require("http");

const app = express();
const server = http.createServer(app);
const io = require("socket.io")(server, {
  cors: { origin: "*" } // allow Pages or any origin; tighten to your domain if you prefer
});

app.use(express.static(path.join(__dirname, "public")));

const TICK_HZ = 20;
const DT = 1 / TICK_HZ;
const ROOM_TTL_MS = 1000 * 60 * 60;
const rooms = Object.create(null);

// --- Helpers ---------------------------------------------------------
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function makeCode(len = 6) {
  let s = "";
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}
function nowMs() { return Date.now(); }

// Deterministic 1D value-noise based on seed
function noise1(seed, y) {
  const y0 = Math.floor(y);
  const y1 = y0 + 1;
  const t = y - y0;
  const rnd = (n) => {
    const x = Math.sin((n + seed) * 12345.678) * 43758.5453;
    return x - Math.floor(x);
  };
  const smooth = t * t * (3 - 2 * t);
  return rnd(y0) * (1 - smooth) + rnd(y1) * smooth;
}

function roadCenterX(seed, yMeters) {
  const n = noise1(seed, yMeters * 0.0025) * 2 - 1; // [-1,1]
  return n * 25;
}

function poiForY(seed, yMeters) {
  const SEG = 800;
  const k = Math.floor(yMeters / SEG);
  const r = noise1(seed + 9999, k * 1.0);
  let type = "none";
  if (r < 0.22) type = "gas";
  else if (r < 0.38) type = "hotel";
  else if (r < 0.54) type = "store";
  else if (r < 0.68) type = "town";
  const centerX = roadCenterX(seed, k * SEG + SEG * 0.5);
  const side = (r < 0.5 ? -1 : 1);
  const x = centerX + side * (7 + 10);
  const y = k * SEG + SEG * 0.5;
  return { k, type, x, y, radius: type === "town" ? 22 : 10 };
}

function makePlayer({ id, name, color }) {
  return {
    id, name, color,
    x: 0, y: 0, angle: 0,
    vx: 0, vy: 0, speed: 0,
    fuel: 100, maxFuel: 100,
    throttle: 0, brake: 0, steer: 0, refuel: false,
    distance: 0,
    ready: false, isHost: false, lastHeard: nowMs(),
  };
}

function snapshotRoom(room) {
  return {
    code: room.code,
    phase: room.phase,
    seed: room.seed,
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, color: p.color,
      ready: p.ready, isHost: p.isHost, distance: p.distance
    })),
  };
}

// --- Rooms and game loop --------------------------------------------
function createRoom() {
  let code;
  do { code = makeCode(); } while (rooms[code]);
  rooms[code] = {
    code,
    createdAt: nowMs(),
    seed: Math.floor(Math.random() * 1e9),
    phase: "lobby",
    players: Object.create(null),
    lastTick: nowMs(),
  };
  return rooms[code];
}

function destroyEmptyStaleRooms() {
  const t = nowMs();
  for (const code of Object.keys(rooms)) {
    const r = rooms[code];
    if (!r) continue;
    if (Object.keys(r.players).length === 0 && (t - r.createdAt) > ROOM_TTL_MS) {
      delete rooms[code];
    }
  }
}

function tickRoom(room) {
  const phys = {
    accel: 8.0,
    brake: 10.0,
    baseFriction: 0.9,
    maxSpeed: 45,
    turnRate: 1.8,
    offroadFriction: 0.65,
    fuelBurn: 0.015,
    roadHalfW: 7.0,
  };

  for (const p of Object.values(room.players)) {
    if (nowMs() - p.lastHeard > 10000) { p.throttle = p.steer = p.brake = 0; p.refuel = false; }

    const cx = roadCenterX(room.seed, p.y);
    const off = Math.abs(p.x - cx);
    const onRoad = off <= phys.roadHalfW;

    const aFwd = (p.throttle * phys.accel) - (p.brake * phys.brake);
    p.speed += aFwd * DT;

    const friction = Math.pow(onRoad ? phys.baseFriction : phys.offroadFriction, DT);
    p.speed *= friction;

    if (p.speed > phys.maxSpeed) p.speed = phys.maxSpeed;
    if (p.speed < -10) p.speed = -10;

    const steerFactor = 0.2 + 0.8 * Math.min(Math.abs(p.speed) / phys.maxSpeed, 1);
    p.angle += p.steer * phys.turnRate * steerFactor * DT;

    const dx = Math.sin(p.angle) * p.speed * DT;
    const dy = Math.cos(p.angle) * p.speed * DT;
    p.x += dx;
    p.y += dy;

    if (dy > 0) p.distance += dy;

    if (p.throttle > 0 && p.speed > 0.2) {
      p.fuel -= phys.fuelBurn * p.throttle * (onRoad ? 1 : 1.8);
      if (p.fuel < 0) p.fuel = 0;
    }

    if (p.refuel && p.fuel < p.maxFuel) {
      const poi = poiForY(room.seed, p.y);
      const dist = Math.hypot(p.x - poi.x, p.y - poi.y);
      if ((poi.type === "gas" || poi.type === "town" || poi.type === "store") && dist <= poi.radius + 3) {
        p.fuel += 30 * DT;
        if (p.fuel > p.maxFuel) p.fuel = p.maxFuel;
      }
    }

    if (p.fuel <= 0 && p.speed > 0) p.speed *= Math.pow(0.5, DT);
  }

  const payload = {
    phase: room.phase,
    seed: room.seed,
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, color: p.color,
      x: p.x, y: p.y, angle: p.angle, speed: p.speed,
      fuel: p.fuel, maxFuel: p.maxFuel, distance: p.distance
    })),
    t: nowMs(),
  };
  io.to(room.code).emit("state", payload);
}

setInterval(() => {
  for (const code of Object.keys(rooms)) {
    const r = rooms[code];
    if (!r) continue;
    if (r.phase === "running") tickRoom(r);
  }
  destroyEmptyStaleRooms();
}, 1000 / TICK_HZ);

// --- Sockets ---------------------------------------------------------
io.on("connection", (socket) => {
  let joinedCode = null;

  // custom ping for the client HUD
  socket.on("pingCheck", (d) => {
    socket.emit("pong", d);
  });

  socket.on("createRoom", ({ name, color }) => {
    const room = createRoom();
    const p = makePlayer({ id: socket.id, name: name?.slice(0,18) || "Driver", color: color || "#5ec8f8" });
    p.isHost = true;
    room.players[socket.id] = p;
    joinedCode = room.code;
    socket.join(room.code);
    socket.emit("joined", { ...snapshotRoom(room), playerId: socket.id });
    io.to(room.code).emit("lobby", snapshotRoom(room));
  });

  socket.on("joinRoom", ({ code, name, color }) => {
    code = (code || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room) return socket.emit("errorMsg", "Room not found.");
    if (room.phase !== "lobby") return socket.emit("errorMsg", "Game already started.");
    if (Object.keys(room.players).length >= 12) return socket.emit("errorMsg", "Room full.");
    const p = makePlayer({ id: socket.id, name: name?.slice(0,18) || "Driver", color: color || "#f6a93b" });
    room.players[socket.id] = p;
    joinedCode = code;
    socket.join(code);
    socket.emit("joined", { ...snapshotRoom(room), playerId: socket.id });
    io.to(code).emit("lobby", snapshotRoom(room));
  });

  socket.on("setReady", (ready) => {
    const r = rooms[joinedCode]; if (!r) return;
    const p = r.players[socket.id]; if (!p) return;
    p.ready = !!ready;
    io.to(joinedCode).emit("lobby", snapshotRoom(r));
  });

  socket.on("startGame", () => {
    const r = rooms[joinedCode]; if (!r) return;
    const p = r.players[socket.id]; if (!p) return;
    if (!p.isHost) return;
    r.phase = "running";
    io.to(joinedCode).emit("start", { seed: r.seed });
  });

  socket.on("input", (data) => {
    const r = rooms[joinedCode]; if (!r) return;
    const p = r.players[socket.id]; if (!p) return;
    p.throttle = Math.max(0, Math.min(1, +data.throttle || 0));
    p.brake = Math.max(0, Math.min(1, +data.brake || 0));
    p.steer = Math.max(-1, Math.min(1, +data.steer || 0));
    p.refuel = !!data.refuel;
    p.lastHeard = nowMs();
  });

  socket.on("leaveRoom", () => {
    const r = rooms[joinedCode]; if (!r) return;
    delete r.players[socket.id];
    socket.leave(joinedCode);
    joinedCode = null;
    if (r && Object.keys(r.players).length === 0) r.createdAt = nowMs() - ROOM_TTL_MS - 1;
    else io.to(r.code).emit("lobby", snapshotRoom(r));
  });

  socket.on("disconnect", () => {
    const r = rooms[joinedCode];
    if (!r) return;
    const wasHost = r.players[socket.id]?.isHost;
    delete r.players[socket.id];
    if (wasHost) {
      const first = Object.values(r.players)[0];
      if (first) first.isHost = true;
    }
    if (Object.keys(r.players).length === 0) r.createdAt = nowMs() - ROOM_TTL_MS - 1;
    else {
      io.to(r.code).emit(r.phase === "lobby" ? "lobby" : "state",
        r.phase === "lobby" ? snapshotRoom(r) : { players: Object.values(r.players) }
      );
    }
  });
});

// --- Start server ----------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Road-Trip Rally server listening on http://localhost:" + PORT);
});
