// Chrome Control MCP - background service worker (MV3)
const DEFAULTS = { enabled: false, token: "", host: "", port: 8765, sites: "", name: "" };

// ---------- the name of this Chrome ----------
// With several Chromes connected, this name tells them apart. A random name is made once and you can change it in the popup.
let nameInit = null;
function ensureName() {
  if (!nameInit) {
    nameInit = (async () => {
      const { name } = await chrome.storage.local.get("name");
      if (name) return name;
      const n = "chrome-" + Math.random().toString(16).slice(2, 6);
      await chrome.storage.local.set({ name: n });
      return n;
    })();
  }
  return nameInit;
}
// Another Chrome took our name: stop reconnecting (it would kick the other one every minute) until something changes.
let nameTaken = false;

// ---------- where the MCP server runs ----------
// Empty host = this computer (127.0.0.1). A domain or IP connects this Chrome to an MCP server on another PC.
// Write "wss://name" to use TLS (for example behind a reverse proxy). The default scheme is ws://.
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function parseTarget(c) {
  let raw = String(c.host || "").trim();
  let scheme = "ws";
  const m = raw.match(/^(wss?):\/\//i);
  if (m) {
    scheme = m[1].toLowerCase();
    raw = raw.slice(m[0].length);
  }
  raw = raw.replace(/\/+$/, "");
  if (!raw) raw = "127.0.0.1";
  if (/^[0-9a-f:]*:[0-9a-f:]*$/i.test(raw)) raw = `[${raw}]`; // bare IPv6
  const valid = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(raw) || /^\[[0-9a-f:.]+\]$/i.test(raw);
  if (!valid) return null;
  const port = Number(c.port) || 8765;
  const url = `${scheme}://${raw}:${port}`;
  try {
    new URL(url);
  } catch {
    return null;
  }
  return { url, label: `${raw}:${port}`, local: LOCAL_HOSTS.has(raw.toLowerCase()) };
}

let ws = null;
let keepTimer = null;
let retryTimer = null;
const attached = new Set();

async function cfg() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

function setStatus(status) {
  chrome.storage.local.set({ status });
  chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
  chrome.action.setBadgeText({ text: status === "connected" ? "ON" : "" });
}

// Live numbers for the popup (session only)
let stats = { attached: 0, commands: 0, last: "", lastAt: 0 };
let statsTimer = null;
function pushStats() {
  stats.attached = attached.size;
  if (statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    chrome.storage.local.set({ stats });
  }, 700);
}
function countCommand(label) {
  stats.commands++;
  stats.last = label;
  stats.lastAt = Date.now();
  pushStats();
}

function send(o) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o));
}

// ---------- site allowlist (empty list = all http/https sites) ----------
function allowed(url, sites) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const list = sites.split(/[\s,]+/).filter(Boolean);
  if (!list.length) return true;
  return list.some((s) => u.hostname === s || u.hostname.endsWith("." + s));
}

async function guard(tabId, sites) {
  const t = await chrome.tabs.get(tabId);
  if (!allowed(t.url || t.pendingUrl || "", sites)) throw new Error("Site not allowed by extension settings");
  return t;
}

// CDP methods that could reach outside the allowed tab
const BLOCKED = [/^Target\./, /^Browser\./, /^Storage\./, /^SystemInfo\./, /^Network\.getAllCookies$/];

// ---------- debugger ----------
const ATTACH_ENABLE = ["Runtime.enable", "Page.enable", "Network.enable", "Log.enable", "DOM.enable"];

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    if (!String(e.message).includes("already attached")) throw e;
  }
  attached.add(tabId);
  pushStats();
  for (const m of ATTACH_ENABLE) {
    try {
      await chrome.debugger.sendCommand({ tabId }, m);
    } catch {}
  }
}

async function detach(tabId) {
  attached.delete(tabId);
  pushStats();
  try {
    await chrome.debugger.detach({ tabId });
  } catch {}
}

async function detachAll() {
  await Promise.all([...attached].map(detach));
}

// Only these debugger events are sent to the MCP server
const FORWARD = new Set([
  "Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded",
  "Network.requestWillBeSent", "Network.requestWillBeSentExtraInfo", "Network.responseReceived",
  "Network.responseReceivedExtraInfo", "Network.loadingFinished", "Network.loadingFailed",
  "Page.frameNavigated", "Page.javascriptDialogOpening", "Page.javascriptDialogClosed", "Page.fileChooserOpened",
  "HeapProfiler.addHeapSnapshotChunk", "Tracing.dataCollected", "Tracing.tracingComplete",
]);

chrome.debugger.onEvent.addListener((src, method, params) => {
  if (!FORWARD.has(method)) return;
  send({ type: "event", tabId: src.tabId, method, params });
});

chrome.debugger.onDetach.addListener((src) => {
  attached.delete(src.tabId);
  pushStats();
});

// ---------- commands from the MCP server ----------
async function handle(method, p) {
  countCommand(method === "cdp" ? p.method : method);
  const c = await cfg();
  switch (method) {
    case "tabs.list": {
      const tabs = await chrome.tabs.query({});
      return tabs
        .filter((t) => allowed(t.url || "", c.sites))
        .map((t) => ({ id: t.id, windowId: t.windowId, title: t.title, url: t.url, active: t.active, status: t.status }));
    }
    case "tabs.get": {
      const t = await guard(p.tabId, c.sites);
      return { id: t.id, windowId: t.windowId, title: t.title, url: t.url, active: t.active, status: t.status };
    }
    case "tabs.create": {
      if (!allowed(p.url, c.sites)) throw new Error("Site not allowed by extension settings");
      const t = await chrome.tabs.create({ url: p.url, active: !!p.active });
      return { id: t.id };
    }
    case "tabs.focus": {
      const t = await guard(p.tabId, c.sites);
      await chrome.tabs.update(p.tabId, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      return "ok";
    }
    case "tabs.close": {
      await guard(p.tabId, c.sites);
      await detach(p.tabId);
      await chrome.tabs.remove(p.tabId);
      return "ok";
    }
    case "attach": {
      await guard(p.tabId, c.sites);
      await ensureAttached(p.tabId);
      return "ok";
    }
    case "detach": {
      await detach(p.tabId);
      return "ok";
    }
    case "window.resize": {
      const t = await guard(p.tabId, c.sites);
      await chrome.windows.update(t.windowId, { width: p.width, height: p.height, state: "normal" });
      return "ok";
    }
    case "cdp": {
      await guard(p.tabId, c.sites);
      if (BLOCKED.some((re) => re.test(p.method))) throw new Error("Blocked CDP method: " + p.method);
      if (p.method === "Page.navigate" && !allowed(p.params?.url || "", c.sites)) {
        throw new Error("Target site not allowed by extension settings");
      }
      await ensureAttached(p.tabId);
      return await chrome.debugger.sendCommand({ tabId: p.tabId }, p.method, p.params || {});
    }
    case "ext.reload": {
      setTimeout(() => chrome.runtime.reload(), 200);
      return "reloading";
    }
    default:
      throw new Error("Unknown method: " + method);
  }
}

async function onMessage(raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.type === "pong") return;
  try {
    send({ id: m.id, result: await handle(m.method, m.params || {}) });
  } catch (e) {
    send({ id: m.id, error: String(e.message || e) });
  }
}

// ---------- config from the local native host ----------
// `npx chrome-control-mcp setup` installs a small native host. It gives us the token and port,
// so nobody has to paste anything. It also turns the extension ON the first time.
const HOST = "com.chromecontrol.mcp";
let lastHostSync = 0;

async function syncFromHost() {
  const now = Date.now();
  if (now - lastHostSync < 60000) return;
  lastHostSync = now;
  try {
    const r = await chrome.runtime.sendNativeMessage(HOST, { type: "config" });
    if (!r || !r.ok) return;
    const cur = await cfg();
    const { autoEnabled } = await chrome.storage.local.get("autoEnabled");
    const upd = {};
    if (r.token && r.token !== cur.token) upd.token = r.token;
    if (r.token) {
      const { tokenSource } = await chrome.storage.local.get("tokenSource");
      if (tokenSource !== "native") upd.tokenSource = "native";
    }
    if (r.port && Number(r.port) !== Number(cur.port)) upd.port = Number(r.port);
    if (!autoEnabled) {
      upd.enabled = true;
      upd.autoEnabled = true;
    }
    if (Object.keys(upd).length) await chrome.storage.local.set(upd);
  } catch {
    // host not installed: manual token still works
  }
}

// ---------- connection ----------
let connecting = null;

function connect() {
  if (!connecting) connecting = doConnect().finally(() => (connecting = null));
  return connecting;
}

async function doConnect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  // The native host only knows this computer's token and port, so it is used only for a local target.
  // For a remote server it would overwrite the token and port you typed.
  await ensureName();
  const target0 = parseTarget(await cfg());
  if (target0 && target0.local) await syncFromHost();
  const c = await cfg();
  if (!c.enabled) return setStatus("off");
  const target = parseTarget(c);
  if (!target) return setStatus("bad host");
  if (!c.token) return setStatus("no token");
  if (nameTaken) return setStatus("name in use");
  setStatus("connecting");
  const sock = new WebSocket(`${target.url}/?token=${encodeURIComponent(c.token)}&name=${encodeURIComponent(c.name)}`);
  ws = sock;
  sock.onopen = () => {
    stats = { attached: attached.size, commands: 0, last: "", lastAt: 0 };
    pushStats();
    setStatus("connected");
    clearInterval(keepTimer);
    keepTimer = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify({ type: "ping" })), 20000);
  };
  sock.onmessage = (e) => onMessage(e.data);
  sock.onerror = () => {};
  sock.onclose = async (ev) => {
    if (ws !== sock) return;
    ws = null;
    clearInterval(keepTimer);
    await detachAll();
    const { enabled } = await cfg();
    if (ev && ev.code === 4001) {
      nameTaken = true;
      return setStatus("name in use");
    }
    setStatus(enabled ? "disconnected" : "off");
    if (enabled) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, 3000);
    }
  };
}

async function disconnect() {
  clearTimeout(retryTimer);
  clearInterval(keepTimer);
  if (ws) {
    const s = ws;
    ws = null;
    s.close();
  }
  await detachAll();
}

chrome.storage.onChanged.addListener(async (ch) => {
  const changed = (k) => ch[k] && ch[k].oldValue !== ch[k].newValue;
  if (changed("host")) lastHostSync = 0; // going back to local: read the local token again right away
  if (changed("name") || changed("enabled") || changed("host") || changed("port") || changed("token")) nameTaken = false;
  if (changed("enabled") || changed("token") || changed("host") || changed("port") || changed("name")) {
    await disconnect();
    await connect();
  }
  if (changed("sites")) {
    const { sites } = await cfg();
    for (const id of [...attached]) {
      try {
        const t = await chrome.tabs.get(id);
        if (!allowed(t.url || "", sites)) await detach(id);
      } catch {
        await detach(id);
      }
    }
  }
});

chrome.alarms.create("reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
