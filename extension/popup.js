const $ = (id) => document.getElementById(id);
const DEFAULTS = { enabled: false, token: "", port: 8765, sites: "", status: "off", tokenSource: "", stats: {} };

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
  if (s.status === "no token") return { cls: "state-nokey", word: "NO KEY", sub: "RUN: NPX CHROME-CONTROL-MCP SETUP" };
  return { cls: "state-nosig", word: "NO SIGNAL", sub: `MCP SERVER NOT FOUND ON PORT ${port}` };
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

  // do not overwrite a field the user is typing in
  for (const [id, val] of [["token", state.token || ""], ["port", state.port || 8765], ["sites", state.sites || ""]]) {
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

for (const id of ["token", "port", "sites"]) {
  $(id).addEventListener("change", async () => {
    const upd = {
      token: $("token").value.trim(),
      port: Number($("port").value) || 8765,
      sites: $("sites").value,
    };
    if (upd.token !== state.token) upd.tokenSource = upd.token ? "manual" : "";
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
