import { WebSocketServer, WebSocket } from "ws";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

export const PORT = Number(process.env.CHROME_BRIDGE_PORT ?? 8765);
const CONFIG_DIR = join(homedir(), ".chrome-control-mcp");

export function loadToken(): string {
  if (process.env.CHROME_BRIDGE_TOKEN) return process.env.CHROME_BRIDGE_TOKEN;
  const file = join(CONFIG_DIR, "token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(CONFIG_DIR, { recursive: true });
  const t = randomBytes(24).toString("hex");
  writeFileSync(file, t, { mode: 0o600 });
  return t;
}

/** Emits: "cdp" (tabId, method, params), "connected", "disconnected" */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

// One MCP instance owns the port and talks to the extension. Other instances
// (for example a second Claude window) connect to the owner as peers and share it.
type Mode = "none" | "owner" | "peer";
let TOKEN = "";
let mode: Mode = "none";
let ext: WebSocket | null = null; // owner: the extension socket
let peerSock: WebSocket | null = null; // peer: socket to the owner
const peers = new Set<WebSocket>(); // owner: connected peers
let nextId = 1;
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; sock: WebSocket };
const pending = new Map<number, Pending>();

const open = (s: WebSocket | null): s is WebSocket => !!s && s.readyState === WebSocket.OPEN;

export async function bridgeInfo(): Promise<{ mode: Mode; extension: boolean; peers?: number; error?: string }> {
  if (mode === "owner") return { mode, extension: open(ext), peers: peers.size };
  if (mode === "peer") {
    try {
      const r = await call("__status", {}, 5000);
      return { mode, extension: !!r.extension };
    } catch (e) {
      return { mode, extension: false, error: (e as Error).message };
    }
  }
  return { mode, extension: false };
}

function settle(m: any) {
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  clearTimeout(p.timer);
  if (m.error) p.reject(new Error(m.error));
  else p.resolve(m.result);
}
function rejectFor(sock: WebSocket, msg: string) {
  for (const [id, p] of pending) {
    if (p.sock !== sock) continue;
    clearTimeout(p.timer);
    pending.delete(id);
    p.reject(new Error(msg));
  }
}

function callOn(sock: WebSocket | null, method: string, params: object, timeoutMs: number, notReady: string): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!open(sock)) return reject(new Error(notReady));
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, sock });
    sock.send(JSON.stringify({ id, method, params }));
  });
}

export function call(method: string, params: object = {}, timeoutMs = 30000): Promise<any> {
  if (mode === "peer") return callOn(peerSock, method, params, timeoutMs, "Not connected to the bridge owner yet. Try again in a few seconds.");
  return callOn(ext, method, params, timeoutMs, "Extension not connected. Open the extension popup and turn it ON.");
}

export const cdp = (tabId: number, method: string, params: object = {}, timeoutMs = 30000) =>
  call("cdp", { tabId, method, params }, timeoutMs);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function broadcast(raw: string) {
  for (const p of peers) if (open(p)) p.send(raw);
}

// ---------- owner ----------
function tryOwner() {
  const wss = new WebSocketServer({
    host: "127.0.0.1", // localhost only
    port: PORT,
    verifyClient: (info, done) => {
      const origin = info.origin || "";
      const url = new URL(info.req.url ?? "/", "http://127.0.0.1");
      const tokenOk = url.searchParams.get("token") === TOKEN;
      const isPeer = url.searchParams.get("role") === "peer";
      // Extension: chrome-extension:// origin. Peer: a local program (no Origin header). Websites always send an Origin.
      const ok = tokenOk && (isPeer ? origin === "" : origin.startsWith("chrome-extension://"));
      done(ok, 401, "Unauthorized");
    },
  });
  wss.on("listening", () => {
    mode = "owner";
    console.error(`[bridge] owner: listening on 127.0.0.1:${PORT}`);
  });
  wss.on("error", (e: any) => {
    if (e.code === "EADDRINUSE") {
      try {
        wss.close();
      } catch {}
      connectPeer();
    } else console.error("[bridge] websocket server error:", e.message);
  });
  wss.on("connection", (ws, req) => {
    const role = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("role");
    if (role === "peer") handlePeer(ws);
    else handleExtension(ws);
  });
}

function handleExtension(ws: WebSocket) {
  if (ext && ext !== ws) ext.close();
  ext = ws;
  console.error("[bridge] extension connected");
  bus.emit("connected");
  broadcast(JSON.stringify({ type: "ext", connected: true }));
  ws.on("message", (data) => {
    const raw = data.toString();
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" })); // traffic both ways keeps the MV3 worker alive
      return;
    }
    if (m.type === "event") {
      bus.emit("cdp", m.tabId, m.method, m.params);
      broadcast(raw);
      return;
    }
    settle(m);
  });
  ws.on("close", () => {
    if (ext !== ws) return;
    ext = null;
    console.error("[bridge] extension disconnected");
    rejectFor(ws, "Extension disconnected");
    bus.emit("disconnected");
    broadcast(JSON.stringify({ type: "ext", connected: false }));
  });
}

function handlePeer(ws: WebSocket) {
  peers.add(ws);
  console.error(`[bridge] peer connected (${peers.size})`);
  ws.send(JSON.stringify({ type: "ext", connected: open(ext) }));
  ws.on("message", (data) => {
    let m: any;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (m.method === "__status") {
      ws.send(JSON.stringify({ id: m.id, result: { extension: open(ext), peers: peers.size } }));
      return;
    }
    if (m.id === undefined || !m.method) return;
    callOn(ext, m.method, m.params ?? {}, 300000, "Extension not connected. Open the extension popup and turn it ON.").then(
      (result) => open(ws) && ws.send(JSON.stringify({ id: m.id, result })),
      (err) => open(ws) && ws.send(JSON.stringify({ id: m.id, error: (err as Error).message }))
    );
  });
  ws.on("close", () => {
    peers.delete(ws);
  });
}

// ---------- peer ----------
function connectPeer() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(TOKEN)}&role=peer`);
  let opened = false;
  ws.on("open", () => {
    opened = true;
    mode = "peer";
    peerSock = ws;
    console.error("[bridge] peer: sharing the extension through the owner instance");
  });
  ws.on("message", (data) => {
    let m: any;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (m.type === "event") bus.emit("cdp", m.tabId, m.method, m.params);
    else if (m.type === "ext") bus.emit(m.connected ? "connected" : "disconnected");
    else if (m.id !== undefined) settle(m);
  });
  ws.on("error", () => {});
  ws.on("close", () => {
    if (peerSock === ws) {
      peerSock = null;
      rejectFor(ws, "Lost connection to the bridge owner");
      bus.emit("disconnected");
    }
    if (mode === "peer" || !opened) mode = "none";
    setTimeout(tryOwner, opened ? 500 + Math.random() * 1500 : 3000); // owner may have gone away: try to take over
  });
}

export function startBridge(token: string): void {
  TOKEN = token;
  tryOwner();
}
