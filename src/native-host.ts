// Native Messaging host. Chrome starts this when the extension asks for its config.
// It only returns the local token and port. Protocol: 4 byte little-endian length + JSON, on stdin and stdout.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const DIR = join(homedir(), ".chrome-control-mcp");

function token(): string {
  if (process.env.CHROME_BRIDGE_TOKEN) return process.env.CHROME_BRIDGE_TOKEN;
  const f = join(DIR, "token");
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  mkdirSync(DIR, { recursive: true });
  const t = randomBytes(24).toString("hex");
  writeFileSync(f, t, { mode: 0o600 });
  return t;
}

function port(): number {
  if (process.env.CHROME_BRIDGE_PORT) return Number(process.env.CHROME_BRIDGE_PORT);
  try {
    const c = JSON.parse(readFileSync(join(DIR, "config.json"), "utf8"));
    if (Number(c.port) > 0) return Number(c.port);
  } catch {}
  return 8765;
}

function send(obj: unknown) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]), () => process.exit(0));
}

let buf: Buffer = Buffer.alloc(0);
process.stdin.on("data", (d: Buffer) => {
  buf = Buffer.concat([buf, d]);
  if (buf.length < 4) return;
  const len = buf.readUInt32LE(0);
  if (buf.length < 4 + len) return;
  let msg: any = {};
  try {
    msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
  } catch {}
  if (msg.type === "config") send({ ok: true, token: token(), port: port(), version: 1 });
  else send({ ok: false, error: "unknown request" });
});
process.stdin.on("end", () => process.exit(0));
