import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadToken } from "./bridge.js";

export const HOST_NAME = "com.chromecontrol.mcp";
/** Extension ID pinned by the "key" field in extension/manifest.json. */
export const DEV_EXTENSION_ID = "ommdbcleeojmjlkimeficggcjgbapmhk";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = join(homedir(), ".chrome-control-mcp");
export const HOST_DIR = join(BASE, "native-host");
export const EXT_DIR = join(BASE, "extension");
const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";

const BROWSERS = [
  { name: "Chrome", win: "Software\\Google\\Chrome", mac: "Google/Chrome", linux: "google-chrome" },
  { name: "Edge", win: "Software\\Microsoft\\Edge", mac: "Microsoft Edge", linux: "microsoft-edge" },
  { name: "Brave", win: "Software\\BraveSoftware\\Brave-Browser", mac: "BraveSoftware/Brave-Browser", linux: "BraveSoftware/Brave-Browser" },
  { name: "Chromium", win: "Software\\Chromium", mac: "Chromium", linux: "chromium" },
];

function manifestDir(b: (typeof BROWSERS)[number]): string {
  return MAC
    ? join(homedir(), "Library", "Application Support", b.mac, "NativeMessagingHosts")
    : join(homedir(), ".config", b.linux, "NativeMessagingHosts");
}

interface Opts {
  extensionIds: string[];
  claudeDesktop: boolean;
  claudeCode: boolean;
  force: boolean;
  open: boolean;
  flag: boolean;
}
function parseArgs(args: string[]): Opts {
  // By default setup also adds the MCP to Claude Desktop and Claude Code when they are installed.
  const o: Opts = { extensionIds: [DEV_EXTENSION_ID], claudeDesktop: true, claudeCode: true, force: false, open: true, flag: true };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--all") o.claudeDesktop = o.claudeCode = true;
    else if (a === "--no-claude") o.claudeDesktop = o.claudeCode = false;
    else if (a === "--no-claude-desktop") o.claudeDesktop = false;
    else if (a === "--no-claude-code") o.claudeCode = false;
    else if (a === "--claude-desktop") o.claudeDesktop = true;
    else if (a === "--claude-code") o.claudeCode = true;
    else if (a === "--force") o.force = true;
    else if (a === "--no-open") o.open = false;
    else if (a === "--no-flag") o.flag = false;
    else if (a === "--extension-id" || a.startsWith("--extension-id=")) {
      const id = a.includes("=") ? a.split("=")[1] : args[++i];
      if (!/^[a-p]{32}$/.test(id ?? "")) throw new Error(`Invalid extension id "${id}". It must be 32 letters from a to p.`);
      o.extensionIds.push(id);
    } else throw new Error(`Unknown option ${a}`);
  }
  return o;
}

function installHost(ids: string[]): { manifestPath: string; registered: string[] } {
  const hostJs = join(PKG_ROOT, "dist", "native-host.js");
  if (!existsSync(hostJs)) throw new Error("dist/native-host.js is missing. Run npm run build first.");
  mkdirSync(HOST_DIR, { recursive: true });
  copyFileSync(hostJs, join(HOST_DIR, "native-host.mjs")); // .mjs so it runs as ESM without a package.json
  const node = process.execPath;
  let launcher: string;
  if (WIN) {
    launcher = join(HOST_DIR, "native-host.bat");
    writeFileSync(launcher, `@echo off\r\n"${node}" "%~dp0native-host.mjs" %*\r\n`);
  } else {
    launcher = join(HOST_DIR, "native-host.sh");
    writeFileSync(launcher, `#!/bin/sh\nexec "${node}" "$(dirname "$0")/native-host.mjs" "$@"\n`);
    chmodSync(launcher, 0o755);
  }
  const manifest = {
    name: HOST_NAME,
    description: "Chrome Control MCP: gives the extension its local token and port",
    path: launcher,
    type: "stdio",
    allowed_origins: [...new Set(ids)].map((id) => `chrome-extension://${id}/`),
  };
  const manifestPath = join(HOST_DIR, `${HOST_NAME}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const registered: string[] = [];
  for (const b of BROWSERS) {
    if (WIN) {
      const key = `HKCU\\${b.win}\\NativeMessagingHosts\\${HOST_NAME}`;
      const r = spawnSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], { encoding: "utf8" });
      if (r.status === 0) registered.push(b.name);
    } else {
      const dir = manifestDir(b);
      if (!existsSync(dirname(dir))) continue; // browser not installed
      mkdirSync(dir, { recursive: true });
      copyFileSync(manifestPath, join(dir, `${HOST_NAME}.json`));
      registered.push(b.name);
    }
  }
  return { manifestPath, registered };
}

function claudeDesktopConfigs(): string[] {
  const out: string[] = [];
  if (WIN) {
    if (process.env.APPDATA) out.push(join(process.env.APPDATA, "Claude", "claude_desktop_config.json"));
    const pk = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Packages") : "";
    if (pk && existsSync(pk)) {
      for (const d of readdirSync(pk)) {
        if (d.startsWith("Claude_")) out.push(join(pk, d, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
      }
    }
  } else if (MAC) out.push(join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"));
  else out.push(join(homedir(), ".config", "Claude", "claude_desktop_config.json"));
  return out.filter((f) => existsSync(f));
}

function configureClaudeDesktop(force: boolean, log: (s: string) => void) {
  const files = claudeDesktopConfigs();
  if (!files.length) return log("  Claude Desktop config not found. Skipped.");
  for (const f of files) {
    let cfg: any;
    try {
      cfg = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      log(`  Could not read ${f} as JSON. Skipped.`);
      continue;
    }
    cfg.mcpServers = cfg.mcpServers ?? {};
    if (cfg.mcpServers["chrome-control"] && !force) {
      log(`  Already set in ${f}. Use --force to replace.`);
      continue;
    }
    copyFileSync(f, `${f}.bak-chrome-control`);
    cfg.mcpServers["chrome-control"] = WIN
      ? { command: "cmd", args: ["/c", "npx", "-y", "chrome-control-mcp"] }
      : { command: "npx", args: ["-y", "chrome-control-mcp"] };
    writeFileSync(f, JSON.stringify(cfg, null, 2));
    log(`  Added chrome-control to ${f} (backup saved next to it). Restart Claude Desktop.`);
  }
}

function configureClaudeCode(log: (s: string) => void) {
  const v = spawnSync("claude", ["--version"], { encoding: "utf8", shell: WIN });
  if (v.status !== 0) return log("  Claude Code CLI not found. Skipped.");
  const r = spawnSync("claude", ["mcp", "add", "chrome-control", "--", "npx", "-y", "chrome-control-mcp"], { encoding: "utf8", shell: WIN });
  const msg = `${r.stderr || ""}${r.stdout || ""}`;
  if (r.status === 0) log("  Added chrome-control to Claude Code.");
  else if (/already exists/i.test(msg)) log("  Already set in Claude Code.");
  else log(`  Could not add it to Claude Code (${msg.trim().split("\n")[0] || "unknown error"}).\n  Run it yourself: claude mcp add chrome-control -- npx -y chrome-control-mcp`);
}

/** Best effort: copy text to the clipboard. Returns true on success. */
function copyToClipboard(text: string): boolean {
  const r = WIN
    ? spawnSync("clip", { input: text, shell: true })
    : MAC
      ? spawnSync("pbcopy", { input: text })
      : spawnSync("xclip", ["-selection", "clipboard"], { input: text });
  return r.status === 0;
}

/** Best effort: open chrome://extensions in Chrome. Returns true on success. */
function openExtensionsPage(): boolean {
  const url = "chrome://extensions";
  const r = WIN
    ? spawnSync("cmd", ["/c", "start", "", "chrome", url], { stdio: "ignore" })
    : MAC
      ? spawnSync("open", ["-a", "Google Chrome", url], { stdio: "ignore" })
      : spawnSync("google-chrome", [url], { stdio: "ignore" });
  return r.status === 0;
}

export const DEBUG_FLAG = "--silent-debugger-extension-api";

/** Windows: add the flag to Chrome, Edge and Brave shortcuts (desktop, Start menu, taskbar). */
function patchWindowsShortcuts(log: (s: string) => void) {
  const script = [
    "$flag = '" + DEBUG_FLAG + "'",
    "$dirs = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'),",
    "  [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'),",
    "  (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar')) | Where-Object { $_ -and (Test-Path $_) }",
    "$sh = New-Object -ComObject WScript.Shell",
    "foreach ($d in $dirs) { Get-ChildItem -Path $d -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {",
    "  try { $l = $sh.CreateShortcut($_.FullName)",
    "    if ($l.TargetPath -match '(chrome|msedge|brave)\\.exe$') {",
    "      if ($l.Arguments -notlike \"*$flag*\") { $l.Arguments = ($l.Arguments + ' ' + $flag).Trim(); $l.Save(); Write-Output ('patched|' + $_.FullName) }",
    "      else { Write-Output ('already|' + $_.FullName) } } } catch { Write-Output ('failed|' + $_.FullName) } } }",
  ].join("\n");
  const f = join(tmpdir(), "chrome-control-shortcuts.ps1");
  writeFileSync(f, script);
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f], { encoding: "utf8" });
  rmSync(f, { force: true });
  const rows = String(r.stdout || "").split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean).map((l) => l.split("|"));
  const n = (k: string) => rows.filter((x) => x[0] === k).length;
  log(`   Shortcuts patched: ${n("patched")}, already set: ${n("already")}, could not edit: ${n("failed")}`);
  if (n("failed")) log("   (Shortcuts in shared folders may need an administrator. Add the flag to them by hand.)");
  if (!rows.length) log("   No Chrome shortcuts found. Start Chrome with: chrome-control-mcp chrome");
}

/** Linux: user-level copies of the .desktop launchers with the flag added. */
function patchLinuxLaunchers(log: (s: string) => void) {
  const out = join(homedir(), ".local", "share", "applications");
  let n = 0;
  for (const name of ["google-chrome.desktop", "microsoft-edge.desktop", "brave-browser.desktop", "chromium.desktop"]) {
    const src = ["/usr/share/applications", "/var/lib/snapd/desktop/applications"].map((d) => join(d, name)).find(existsSync);
    if (!src) continue;
    const txt = readFileSync(src, "utf8").replace(/^(Exec=.*)$/gm, (l) => (l.includes(DEBUG_FLAG) ? l : l.replace(/(Exec=\S+)/, `$1 ${DEBUG_FLAG}`)));
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, name), txt);
    n++;
  }
  log(`   Launchers written to ${out}: ${n}`);
}

/** Start the browser with the debugger banner hidden. */
export function launchChrome(): void {
  const cands = WIN
    ? [join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"),
       join(process.env["PROGRAMFILES(X86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
       join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe")]
    : MAC ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];
  const exe = cands.find(existsSync);
  if (!exe) throw new Error("Chrome was not found. Start it yourself with the flag " + DEBUG_FLAG);
  spawn(exe, [DEBUG_FLAG], { detached: true, stdio: "ignore" }).unref();
  console.log(`Started Chrome with ${DEBUG_FLAG}. If Chrome was already running, quit it fully first and run this again.`);
}

export function runSetup(args: string[]) {
  const o = parseArgs(args);
  const log = (s: string) => console.log(s);
  log("chrome-control-mcp setup\n");
  loadToken(); // creates the token file if needed. It is never printed.
  log("1. Token ready.");
  if (process.env.CHROME_BRIDGE_PORT) {
    mkdirSync(BASE, { recursive: true });
    writeFileSync(join(BASE, "config.json"), JSON.stringify({ port: Number(process.env.CHROME_BRIDGE_PORT) }));
  }
  const h = installHost(o.extensionIds);
  log(`2. Native host installed in ${HOST_DIR}`);
  log(`   Registered for: ${h.registered.length ? h.registered.join(", ") : "no browser found"}`);
  mkdirSync(BASE, { recursive: true });
  cpSync(join(PKG_ROOT, "extension"), EXT_DIR, { recursive: true, force: true });
  log(`3. Extension copied to ${EXT_DIR}`);
  if (o.claudeDesktop || o.claudeCode) log("4. Claude config:");
  if (o.claudeDesktop) configureClaudeDesktop(o.force, log);
  if (o.claudeCode) configureClaudeCode(log);
  log("\nNext:");
  log("  Open chrome://extensions, turn on Developer mode, click Load unpacked, and pick this folder:");
  log(`  ${EXT_DIR}`);
  if (o.open) {
    if (copyToClipboard(EXT_DIR)) log("  (Folder path copied to your clipboard. Paste it in the folder picker.)");
    if (openExtensionsPage()) log("  (Opened chrome://extensions for you.)");
  }
  log("  The extension gets its token by itself and turns ON. You do not paste anything.");
  if (!o.claudeDesktop && !o.claudeCode) {
    log("\nClaude was skipped (--no-claude). Run setup again without that flag to add the MCP to Claude.");
  }
}

export function runUninstall() {
  const log = (s: string) => console.log(s);
  for (const b of BROWSERS) {
    if (WIN) spawnSync("reg", ["delete", `HKCU\\${b.win}\\NativeMessagingHosts\\${HOST_NAME}`, "/f"], { encoding: "utf8" });
    else rmSync(join(manifestDir(b), `${HOST_NAME}.json`), { force: true });
  }
  rmSync(HOST_DIR, { recursive: true, force: true });
  rmSync(EXT_DIR, { recursive: true, force: true });
  log("Removed the native host registration, the host files and the extension copy.");
  log("Your token file was kept. Remove the extension in chrome://extensions yourself.");
}
