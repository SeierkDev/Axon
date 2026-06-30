// Phase 10 (10.6): Axon World realtime presence server.
//
// A tiny standalone WebSocket service that lets visitors see each other walking
// around the shared village in real time. Purely ephemeral — no database, no
// persistence: it holds a single in-memory room of connected players and relays
// their pose (position + heading + motion state) to everyone else.
//
// Deploy as a SEPARATE Railway service:  `npm run presence`  (listens on $PORT).
// The Next.js app connects to it via NEXT_PUBLIC_PRESENCE_URL (wss://…). If that
// env var is unset, the world simply runs solo — this service is optional.
//
// Runs independently of the Next app: nothing here is imported by the client
// bundle (the browser uses its native WebSocket), so `ws` never ships to users.

import { createServer } from "http";
import { WebSocketServer, type WebSocket } from "ws";

const PORT = Number(process.env.PORT ?? 8787);
// Optional comma-separated origin allowlist (e.g. https://axon.example.com).
const ALLOWED_ORIGINS = (process.env.PRESENCE_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_PEERS = Number(process.env.PRESENCE_MAX_PEERS ?? 200);
const IDLE_MS = 30_000;
// Hardening (launch abuse control): cap raw sockets (not just joined peers) so
// silent connect-floods can't grow FDs unbounded; drop clients that connect but
// never join; small max frame; and a per-socket message-rate cap so one client
// can't spam pose/update and amplify a broadcast storm across every visitor.
const MAX_SOCKETS = MAX_PEERS * 3;
const JOIN_TIMEOUT_MS = 10_000;
const MAX_MSG_PER_SEC = 40; // legit clients send ~10-20 pose/s; well above that
const MAX_FRAME_BYTES = 8 * 1024; // messages are tiny; 8 KiB is generous
let openSockets = 0;

const HEX = /^#[0-9a-fA-F]{6}$/;
type Look = { skin: string; hair: string; shirt: string; pants: string; hat: string; hairStyle: string; hatStyle: string; flair: string };
const DEFAULT_LOOK: Look = { skin: "#e8c0a0", hair: "#4a3419", shirt: "#86d0cf", pants: "#6f8aa8", hat: "#7c4a2a", hairStyle: "short", hatStyle: "none", flair: "none" };
const HAIR_STYLES = new Set(["none", "short", "ponytail", "bun", "spiky"]);
const HAT_STYLES = new Set(["none", "cowboy", "cap", "beanie", "bucket"]);
// Earned wearables — visible progression from the minigames.
const FLAIRS = new Set(["none", "crown", "rod"]);
const oneOf = (v: unknown, set: Set<string>, dflt: string) => (typeof v === "string" && set.has(v) ? v : dflt);

interface Peer {
  id: string;
  name: string;
  look: Look;
  x: number;
  z: number;
  ry: number;
  st: string; // idle | walk | run | jump
  ws: WebSocket;
  lastSeen: number;
  lastChat: number;
  lastGift: number;
}

const EMOTES = new Set(["wave", "smile", "heart", "party", "sad", "sleep"]);
const cleanText = (v: unknown) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 200) : "";

const peers = new Map<string, Peer>();
let nextId = 1;

// ── sanitizers (never trust the client) ──────────────────────────────────────
const clampCoord = (v: unknown) => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  // The OPEN WORLD is much larger than the old island — clamp generously.
  return Math.max(-600, Math.min(600, n));
};
const clampAngle = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const STATES = new Set(["idle", "walk", "run", "jump", "sit", "fish"]);
const cleanState = (v: unknown) => (typeof v === "string" && STATES.has(v) ? v : "idle");
const cleanName = (v: unknown) => (typeof v === "string" ? v.slice(0, 24) : "Guest") || "Guest";
const cleanColor = (v: unknown, fallback: string) => (typeof v === "string" && HEX.test(v) ? v : fallback);
function cleanLook(v: unknown): Look {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    skin: cleanColor(o.skin, DEFAULT_LOOK.skin),
    hair: cleanColor(o.hair, DEFAULT_LOOK.hair),
    shirt: cleanColor(o.shirt, DEFAULT_LOOK.shirt),
    pants: cleanColor(o.pants, DEFAULT_LOOK.pants),
    hat: cleanColor(o.hat, DEFAULT_LOOK.hat),
    hairStyle: oneOf(o.hairStyle, HAIR_STYLES, "short"),
    hatStyle: oneOf(o.hatStyle, HAT_STYLES, "none"),
    flair: oneOf(o.flair, FLAIRS, "none"),
  };
}

const meta = (p: Peer) => ({ id: p.id, name: p.name, look: p.look, x: p.x, z: p.z, ry: p.ry, st: p.st });

function send(ws: WebSocket, obj: unknown) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(obj: unknown, exceptId?: string) {
  const msg = JSON.stringify(obj);
  for (const p of peers.values()) if (p.id !== exceptId && p.ws.readyState === p.ws.OPEN) p.ws.send(msg);
}

// HTTP server doubles as a health check endpoint for Railway.
const http = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, service: "axon-presence", players: peers.size }));
});

const wss = new WebSocketServer({
  server: http,
  maxPayload: MAX_FRAME_BYTES, // reject oversized frames before we parse them
  verifyClient: (info, done) => {
    if (openSockets >= MAX_SOCKETS) return done(false, 503, "full");
    if (peers.size >= MAX_PEERS) return done(false, 503, "full");
    if (ALLOWED_ORIGINS.length) {
      const origin = info.origin ?? "";
      if (!ALLOWED_ORIGINS.includes(origin)) return done(false, 403, "forbidden origin");
    }
    done(true);
  },
});

wss.on("connection", (ws: WebSocket) => {
  const id = String(nextId++);
  openSockets++;
  // Drop sockets that connect but never join — otherwise silent connections
  // never count against the peer cap and never hit the idle sweep.
  const joinTimer = setTimeout(() => {
    if (!peers.has(id)) {
      try { ws.terminate(); } catch { /* ignore */ }
    }
  }, JOIN_TIMEOUT_MS);
  // Per-socket message-rate cap (sliding 1s window).
  let msgCount = 0;
  let msgWindow = Date.now();
  let lastUpdate = 0; // name/look changes are rare — throttle the re-render they cause

  ws.on("message", (data) => {
    const now0 = Date.now();
    if (now0 - msgWindow >= 1000) { msgWindow = now0; msgCount = 0; }
    if (++msgCount > MAX_MSG_PER_SEC) return; // drop the flood, keep the socket
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    const p = peers.get(id);

    if (m.t === "join" && !p) {
      const peer: Peer = {
        id,
        name: cleanName(m.name),
        look: cleanLook(m.look),
        x: 0,
        z: 18,
        ry: Math.PI,
        st: "idle",
        ws,
        lastSeen: Date.now(),
        lastChat: 0,
        lastGift: 0,
      };
      peers.set(id, peer);
      clearTimeout(joinTimer);
      send(ws, { t: "welcome", id, peers: [...peers.values()].filter((q) => q.id !== id).map(meta) });
      broadcast({ t: "join", peer: meta(peer) }, id);
      broadcast({ t: "count", n: peers.size });
      send(ws, { t: "count", n: peers.size });
    } else if (m.t === "pose" && p) {
      p.x = clampCoord(m.x);
      p.z = clampCoord(m.z);
      p.ry = clampAngle(m.ry);
      p.st = cleanState(m.st);
      p.lastSeen = Date.now();
      broadcast({ t: "pose", id, x: p.x, z: p.z, ry: p.ry, st: p.st }, id);
    } else if (m.t === "update" && p) {
      const now = Date.now();
      if (now - lastUpdate < 1000) return; // rare event; blunt the re-render storm
      lastUpdate = now;
      p.name = cleanName(m.name);
      p.look = cleanLook(m.look);
      p.lastSeen = now;
      broadcast({ t: "update", id, name: p.name, look: p.look }, id);
    } else if (m.t === "chat" && p) {
      const now = Date.now();
      if (now - p.lastChat < 400) return; // simple anti-spam
      const text = cleanText(m.text);
      if (!text) return;
      p.lastChat = now;
      p.lastSeen = now;
      // Echo to everyone (incl. sender) so the log is consistent for all.
      broadcast({ t: "chat", id, name: p.name, text });
    } else if (m.t === "emote" && p) {
      if (typeof m.e !== "string" || !EMOTES.has(m.e)) return;
      p.lastSeen = Date.now();
      broadcast({ t: "emote", id, name: p.name, e: m.e });
    } else if (m.t === "gift" && p) {
      // Item gifting: only to a real peer standing right next to you, gently
      // rate-limited. The item id is relayed, not trusted — receivers validate
      // against their own item table.
      const now = Date.now();
      if (now - p.lastGift < 1500) return;
      const target = typeof m.to === "string" ? peers.get(m.to) : undefined;
      if (!target || target.id === id) return;
      if (typeof m.item !== "string" || m.item.length === 0 || m.item.length > 32) return;
      if (Math.hypot(p.x - target.x, p.z - target.z) > 8) return;
      p.lastGift = now;
      p.lastSeen = now;
      send(target.ws, { t: "gift", from: id, name: p.name, item: m.item });
    }
  });

  let dropped = false;
  const drop = () => {
    if (dropped) return;
    dropped = true;
    openSockets--;
    clearTimeout(joinTimer);
    if (peers.delete(id)) {
      broadcast({ t: "leave", id });
      broadcast({ t: "count", n: peers.size });
    }
  };
  ws.on("close", drop);
  ws.on("error", drop);
});

// Evict silent connections so ghosts don't linger in the room.
setInterval(() => {
  const now = Date.now();
  for (const p of peers.values()) {
    if (now - p.lastSeen > IDLE_MS) {
      try {
        p.ws.terminate();
      } catch {
        /* ignore */
      }
    }
  }
}, 10_000);

http.listen(PORT, () => {
  console.log(`[presence] Axon World presence server listening on :${PORT}`);
});
