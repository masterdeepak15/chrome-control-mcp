const $ = (id) => document.getElementById(id);
const DEFAULTS = { enabled: false, token: "", host: "", port: 8765, sites: "", name: "", status: "off", tokenSource: "", stats: {} };
const cleanName = (v) => String(v || "").replace(/[^\w .-]/g, "").trim().slice(0, 40);

// "" or a loopback name means this PC. Anything else is another PC.
const hostName = (h) => String(h || "").trim().replace(/^wss?:\/\//i, "").replace(/\/+$/, "");
const isRemote = (h) => !["", "127.0.0.1", "localhost", "::1", "[::1]"].includes(hostName(h).toLowerCase());

let state = { ...DEFAULTS };
let typing = null;

function typeText(el, text) {
  if (el.dataset.full === text) return;
  el.dataset.full = text;
  clearInterval(typing);
  let i = 0;
  el.textContent = "";
  typing = setInterval(() => {
    el.textContent = text.slice(0, ++i);
    if (i >= text.length) clearInterval(typing);
  }, 16);
}

// Map the background worker status to a look and words
function look(s) {
  const port = state.port || 8765;
  if (!state.enabled) return { cls: "state-off", word: "STANDBY", sub: "LINK DISENGAGED" };
  if (s.status === "connected") return { cls: "state-on", word: "ONLINE", sub: "LINK ESTABLISHED" };
  if (s.status === "connecting") return { cls: "state-link", word: "LINKING", sub: "HANDSHAKE IN PROGRESS" };
  if (s.status === "no token") {
    return { cls: "state-nokey", word: "NO KEY", sub: isRemote(s.host) ? "PASTE THE SERVER'S ACCESS KEY" : "RUN: NPX CHROME-CONTROL-MCP SETUP" };
  }
  if (s.status === "name in use") return { cls: "state-nokey", word: "NAME TAKEN", sub: "ANOTHER CHROME USES THIS NAME. RENAME THIS ONE" };
  if (s.status === "bad host") return { cls: "state-nokey", word: "BAD HOST", sub: "USE A DOMAIN OR IP, NO PATH" };
  const where = isRemote(s.host) ? `${hostName(s.host).toUpperCase()}:${port}` : `PORT ${port}`;
  return { cls: "state-nosig", word: "NO SIGNAL", sub: `MCP SERVER NOT FOUND ON ${where}` };
}

function render() {
  const l = look(state);
  document.body.className = l.cls;
  $("word").textContent = l.word;
  $("word").style.fontSize = l.word.length > 8 ? "15px" : "";
  typeText($("sub"), l.sub);

  const on = !!state.enabled;
  $("engage").setAttribute("aria-checked", String(on));
  $("engageLbl").textContent = on ? "DISENGAGE LINK" : "ENGAGE LINK";

  $("tPort").textContent = state.port || 8765;
  const key = $("tKey");
  key.className = "";
  if (!state.token) {
    key.textContent = "MISSING";
    key.className = "bad";
  } else if (state.tokenSource === "native") key.textContent = "SYNCED";
  else if (state.tokenSource === "manual") key.textContent = "MANUAL";
  else key.textContent = "SET";

  const st = state.stats || {};
  $("tTabs").textContent = st.attached ?? 0;
  $("tCmds").textContent = st.commands ?? 0;
  $("tLast").textContent = st.last ? `${st.last}${st.lastAt ? "  " + new Date(st.lastAt).toLocaleTimeString() : ""}` : "awaiting input";

  const n = (state.sites || "").split(/[\s,]+/).filter(Boolean).length;
  $("scope").textContent = n ? `${n} SITE${n > 1 ? "S" : ""} LOCKED` : "ALL SITES";

  $("where").textContent = isRemote(state.host) ? `REMOTE · ${hostName(state.host)}` : "LOCAL ONLY · 127.0.0.1";

  // do not overwrite a field the user is typing in
  for (const [id, val] of [["token", state.token || ""], ["name", state.name || ""], ["host", state.host || ""], ["port", state.port || 8765], ["sites", state.sites || ""]]) {
    if (document.activeElement !== $(id)) $(id).value = val;
  }
}

async function load() {
  state = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  $("ver").textContent = "v" + chrome.runtime.getManifest().version;
  render();
}

$("engage").addEventListener("click", async () => {
  state.enabled = !state.enabled;
  render();
  await chrome.storage.local.set({ enabled: state.enabled });
});

for (const id of ["token", "name", "host", "port", "sites"]) {
  $(id).addEventListener("change", async () => {
    const upd = {
      token: $("token").value.trim(),
      name: cleanName($("name").value) || state.name, // an empty name is not allowed: keep the old one
      host: $("host").value.trim(),
      port: Number($("port").value) || 8765,
      sites: $("sites").value,
    };
    if (upd.token !== state.token) upd.tokenSource = upd.token ? "manual" : "";
    // The synced token belongs to this PC. It is wrong for another PC, so drop it and ask for the right one.
    else if (isRemote(upd.host) && !isRemote(state.host) && state.tokenSource === "native") {
      upd.token = "";
      upd.tokenSource = "";
    }
    state = { ...state, ...upd };
    render();
    await chrome.storage.local.set(upd);
  });
}

chrome.storage.onChanged.addListener((ch) => {
  for (const [k, v] of Object.entries(ch)) state[k] = v.newValue;
  render();
});

load();
