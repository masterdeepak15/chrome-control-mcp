// Background server control: start, stop, restart, status, logs.
// The server is `chrome-control-mcp serve` (one shared MCP server for many clients). It runs detached, its pid is kept in
// ~/.chrome-control-mcp/server.pid and its output in ~/.chrome-control-mcp/server.log.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(homedir(), ".chrome-control-mcp");
const PID_FILE = join(DIR, "server.pid");
const LOG_FILE = join(DIR, "server.log");
const HTTP_PORT = Number(process.env.CHROME_BRIDGE_HTTP_PORT ?? 8766);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readPid(): number | null {
  try {
    const n = Number(readFileSync(PID_FILE, "utf8").trim());
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM"; // exists, but not ours to signal
  }
}
function clearPid() {
  try {
    unlinkSync(PID_FILE);
  } catch {}
}

/** Answers from the running server, or null when nothing is listening. */
async function health(): Promise<any | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function tail(n: number): string {
  try {
    return readFileSync(LOG_FILE, "utf8").split(/\r?\n/).filter(Boolean).slice(-n).join("\n");
  } catch {
    return "";
  }
}

async function start(): Promise<number> {
  const h = await health();
  if (h) {
    const pid = readPid();
    console.log(`Already running${pid && alive(pid) ? ` (pid ${pid})` : ""}. Use "chrome-control-mcp status" for details.`);
    return 0;
  }
  mkdirSync(DIR, { recursive: true });
  try {
    if (statSync(LOG_FILE).size > 5 * 1024 * 1024) renameSync(LOG_FILE, LOG_FILE + ".1"); // keep the log from growing for ever
  } catch {}
  const fd = openSync(LOG_FILE, "a", 0o600); // only you can read it
  const indexJs = fileURLToPath(new URL("./index.js", import.meta.url));
  const child = spawn(process.execPath, [indexJs, "serve"], { detached: true, stdio: ["ignore", fd, fd], windowsHide: true, env: { ...process.env, CHROME_CONTROL_DAEMON: "1" } });
  closeSync(fd);
  child.unref();
  if (!child.pid) {
    console.error("Could not start the server.");
    return 1;
  }
  writeFileSync(PID_FILE, String(child.pid));
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (await health()) {
      console.log(`Started (pid ${child.pid}).`);
      console.log(`MCP server: http://127.0.0.1:${HTTP_PORT}/mcp   (run "chrome-control-mcp url" for the link with its token)`);
      console.log(`Log: ${LOG_FILE}`);
      return 0;
    }
    if (!alive(child.pid)) break;
  }
  console.error("The server did not come up. Last log lines:");
  console.error(tail(15) || "(log is empty)");
  clearPid();
  return 1;
}

async function stop(force: boolean): Promise<number> {
  const pid = readPid();
  const h = await health();
  if (!pid) {
    console.log(h ? "A server is running, but it was not started with this command, so its pid is unknown. Close its window or terminal to stop it." : "Not running.");
    return h ? 1 : 0;
  }
  if (!alive(pid)) {
    clearPid();
    console.log("Not running (removed a stale pid file).");
    return 0;
  }
  if (!h && !force) {
    // the pid may now belong to another program: do not kill it blindly
    console.error(`Process ${pid} exists but the server is not answering on port ${HTTP_PORT}. If you are sure it is the server, run: chrome-control-mcp stop --force`);
    return 1;
  }
  try {
    process.kill(pid);
  } catch (e) {
    console.error(`Could not stop pid ${pid}: ${(e as Error).message}`);
    return 1;
  }
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(250);
  if (alive(pid)) {
    console.error(`Process ${pid} is still running.`);
    return 1;
  }
  clearPid();
  console.log(`Stopped (pid ${pid}).`);
  return 0;
}

async function status(): Promise<number> {
  const h = await health();
  const pid = readPid();
  if (!h) {
    console.log("Not running.");
    if (pid && !alive(pid)) clearPid();
    console.log('Start it with: chrome-control-mcp start');
    return 1;
  }
  console.log(`Running${pid && alive(pid) ? ` (pid ${pid})` : " (not started with this command, pid unknown)"}`);
  console.log(`MCP server:  http://127.0.0.1:${HTTP_PORT}/mcp`);
  console.log(`Clients:     ${h.sessions ?? 0} connected`);
  console.log(`Role:        ${h.mode}${h.mode === "peer" ? " (another instance owns the extension port)" : ""}`);
  const b: string[] = h.browsers ?? [];
  console.log(`Chromes:     ${b.length ? b.join(", ") : h.extension ? "connected" : "none connected"}`);
  console.log(`Log:         ${LOG_FILE}`);
  return 0;
}

async function logs(args: string[]): Promise<number> {
  const ni = args.findIndex((a) => a === "-n" || a === "--lines");
  const n = ni >= 0 ? Number(args[ni + 1]) || 40 : 40;
  if (!existsSync(LOG_FILE)) {
    console.log("No log yet. Start the server first.");
    return 0;
  }
  const out = tail(n);
  if (out) console.log(out);
  if (!args.includes("-f") && !args.includes("--follow")) return 0;
  // follow: print what is appended until Ctrl+C
  let pos = statSync(LOG_FILE).size;
  for (;;) {
    await sleep(500);
    let size = 0;
    try {
      size = statSync(LOG_FILE).size;
    } catch {
      continue;
    }
    if (size < pos) pos = 0; // the log was rotated
    if (size > pos) {
      const fd = openSync(LOG_FILE, "r");
      const buf = Buffer.alloc(size - pos);
      readSync(fd, buf, 0, buf.length, pos);
      closeSync(fd);
      process.stdout.write(buf.toString("utf8"));
      pos = size;
    }
  }
}

/** Runs one command and returns the exit code. */
export async function runDaemon(sub: string | undefined, args: string[]): Promise<number> {
  switch (sub) {
    case "start":
      return start();
    case "stop":
      return stop(args.includes("--force"));
    case "restart": {
      const code = await stop(args.includes("--force"));
      if (code !== 0) return code;
      return start();
    }
    case "status":
      return status();
    case "logs":
      return logs(args);
    default:
      console.error('Usage: chrome-control-mcp <start|stop|restart|status|logs>   (or: chrome-control-mcp daemon <command>)');
      return 1;
  }
}
