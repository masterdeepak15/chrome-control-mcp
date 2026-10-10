import { WebSocketServer, WebSocket } from "ws";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

export const PORT = Number(process.env.CHROME_BRIDGE_PORT ?? 8765);
// Address the extension socket listens on. Default is this computer only. Set CHROME_BRIDGE_HOST=0.0.0.0
// (or one LAN IP) to let a Chrome on another PC connect. The token is still required.
const HOST = process.env.CHROME_BRIDGE_HOST?.trim() || "127.0.0.1";
const LOOPBACK = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";
// Where local peers (a second Claude window) reach the owner: loopback unless the owner is bound to one specific IP.
const PEER_HOST = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST;
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

// One MCP instance owns the port and talks to the extensions. Other instances
// (for example a second Claude window) connect to the owner as peers and share them.
type Mode = "none" | "owner" | "peer";
let TOKEN = "";
let mode: Mode = "none";
let peerSock: WebSocket | null = null; // peer: socket to the owner
const peers = new Set<WebSocket>(); // owner: connected peers
let nextId = 1;
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; sock: WebSocket };
const pending = new Map<number, Pending>();

// ---------- several Chromes ----------
// Each Chrome connects with a name. The owner keeps one socket per name.
type Browser = { name: string; slot: number; ws: WebSocket; since: number };
const browsers = new Map<string, Browser>(); // owner: connected Chromes by name
const slotOf = new Map<string, number>(); // owner: name -> slot, stable while this process runs

// Tab ids from two Chromes can be equal, so the owner makes them unique. The first Chrome to connect keeps its
// real ids (slot 0). Every other Chrome gets an offset of slot * 1e9. Code outside this file sees one plain number
// per page, and that number also tells the owner which Chrome the page belongs to.
const SLOT = 1_000_000_000;
const enc = (slot: number, tab: number) => slot * SLOT + tab;
const dec = (id: number) => ({ slot: Math.floor(id / SLOT), tab: id % SLOT });
const bySlot = (slot: number) => [...browsers.values()].find((b) => b.slot === slot);
const NOT_CONNECTED = "Extension not connected. Open the extension popup and turn it ON.";
const names = () => [...browsers.keys()].join(", ");
const cleanName = (raw: string | null) => (raw ?? "").replace(/[^\w .-]/g, "").trim().slice(0, 40) || "chrome";
const browserList = () => [...browsers.values()].map((b) => ({ name: b.name, since: b.since }));

function pickBrowser(want?: string): Browser {
  if (!browsers.size) throw new Error(NOT_CONNECTED);
  if (want) {
    const b = browsers.get(want) ?? [...browsers.values()].find((x) => x.name.toLowerCase() === want.toLowerCase());
    if (!b) throw new Error(`No Chrome named "${want}" is connected. Connected: ${names()}.`);
    return b;
  }
  if (browsers.size > 1) throw new Error(`Several Chromes are connected (${names()}). Pass the browser name.`);
  return [...browsers.values()][0];
}

const open = (s: WebSocket | null): s is WebSocket => !!s && s.readyState === WebSocket.OPEN;

export async function bridgeInfo(): Promise<{ mode: Mode; extension: boolean; peers?: number; browsers?: string[]; error?: string }> {
  if (mode === "owner") return { mode, extension: browsers.size > 0, peers: peers.size, browsers: [...browsers.keys()] };
  if (mode === "peer") {
    try {
      const r = await call("__status", {}, 5000);
      return { mode, extension: !!r.extension, browsers: r.browsers };
    } catch (e) {
      return { mode, extension: false, error: (e as Error).message };
    }
  }
  return { mode, extension: false };
}

/** The Chromes that are connected right now (name and connect time). */
export async function listBrowsers(): Promise<{ name: string; since: number }[]> {
  if (mode === "owner") return browserList();
  if (mode === "peer") return call("__browsers", {}, 5000);
  return [];
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

// Owner: send a command to the right Chrome and translate page ids on the way in and out.
async function ownerCall(method: string, params: any, timeoutMs: number): Promise<any> {
  const p: any = { ...params };
  const want = typeof p.browser === "string" && p.browser ? p.browser : undefined;
  delete p.browser; // the extension does not need it

  if (method === "tabs.list") {
    // pages of every connected Chrome, each tagged with the Chrome it belongs to
    const list = [...browsers.values()].filter((b) => !want || b.name === pickBrowser(want).name);
    if (!list.length) throw new Error(NOT_CONNECTED);
    const results = await Promise.allSettled(
      list.map(async (b) => ((await callOn(b.ws, method, p, timeoutMs, NOT_CONNECTED)) as any[]).map((t) => ({ ...t, id: enc(b.slot, t.id), browser: b.name })))
    );
    const ok = results.filter((r): r is PromiseFulfilledResult<any[]> => r.status === "fulfilled");
    if (!ok.length) throw (results[0] as PromiseRejectedResult).reason;
    return ok.flatMap((r) => r.value);
  }

  if (typeof p.tabId === "number") {
    // a page id already says which Chrome it belongs to
    const { slot, tab } = dec(p.tabId);
    const b = bySlot(slot);
    if (!b) throw new Error("The Chrome that owns this page is not connected.");
    const r = await callOn(b.ws, method, { ...p, tabId: tab }, timeoutMs, NOT_CONNECTED);
    return method === "tabs.get" ? { ...r, id: enc(slot, r.id), browser: b.name } : r;
  }

  // no page given (tabs.create, ext.reload): the caller must name the Chrome when more than one is connected
  const b = pickBrowser(want);
  const r = await callOn(b.ws, method, p, timeoutMs, NOT_CONNECTED);
  return method === "tabs.create" ? { ...r, id: enc(b.slot, r.id), browser: b.name } : r;
}

export function call(method: string, params: object = {}, timeoutMs = 30000): Promise<any> {
  if (mode === "peer") return callOn(peerSock, method, params, timeoutMs, "Not connected to the bridge owner yet. Try again in a few seconds.");
  if (mode !== "owner") return Promise.reject(new Error(NOT_CONNECTED));
  if (method === "__browsers") return Promise.resolve(browserList());
  return ownerCall(method, params, timeoutMs);
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
    host: HOST, // localhost only unless CHROME_BRIDGE_HOST says otherwise
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
    console.error(`[bridge] owner: listening on ${HOST}:${PORT}`);
    if (!LOOPBACK) {
      console.error("[bridge] WARNING: open to the network. Traffic is plain ws:// and the token travels in the URL.");
      console.error("[bridge] Use a VPN, an SSH tunnel, or a TLS reverse proxy (wss://) when the PC is not on a trusted network.");
    }
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
    const q = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
    if (q.get("role") === "peer") handlePeer(ws);
    else handleExtension(ws, q.get("name"));
  });
}

function handleExtension(ws: WebSocket, rawName: string | null) {
  const name = cleanName(rawName);
  const old = browsers.get(name);
  if (old && old.ws !== ws) {
    // the same Chrome reconnecting, or a second Chrome with the same name: the newer one wins
    rejectFor(old.ws, "Replaced by a new connection");
    old.ws.close(4001, "Another Chrome connected with the same name");
  }
  let slot = slotOf.get(name);
  if (slot === undefined) {
    slot = slotOf.size; // the first Chrome gets slot 0 and keeps its real tab ids
    slotOf.set(name, slot);
  }
  const b: Browser = { name, slot, ws, since: Date.now() };
  browsers.set(name, b);
  console.error(`[bridge] Chrome "${name}" connected (${browsers.size} connected)`);
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
      const ev = { ...m, tabId: enc(b.slot, m.tabId), browser: name };
      bus.emit("cdp", ev.tabId, ev.method, ev.params);
      broadcast(JSON.stringify(ev));
      return;
    }
    settle(m);
  });
  ws.on("close", () => {
    if (browsers.get(name)?.ws !== ws) return;
    browsers.delete(name);
    console.error(`[bridge] Chrome "${name}" disconnected (${browsers.size} connected)`);
    rejectFor(ws, "Extension disconnected");
    bus.emit("disconnected");
    broadcast(JSON.stringify({ type: "ext", connected: browsers.size > 0 }));
  });
}

function handlePeer(ws: WebSocket) {
  peers.add(ws);
  console.error(`[bridge] peer connected (${peers.size})`);
  ws.send(JSON.stringify({ type: "ext", connected: browsers.size > 0 }));
  ws.on("message", (data) => {
    let m: any;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (m.method === "__status") {
      ws.send(JSON.stringify({ id: m.id, result: { extension: browsers.size > 0, peers: peers.size, browsers: [...browsers.keys()] } }));
      return;
    }
    if (m.method === "__browsers") {
      ws.send(JSON.stringify({ id: m.id, result: browserList() }));
      return;
    }
    if (m.id === undefined || !m.method) return;
    ownerCall(m.method, m.params ?? {}, 300000).then(
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
  const ws = new WebSocket(`ws://${PEER_HOST}:${PORT}/?token=${encodeURIComponent(TOKEN)}&role=peer`);
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
