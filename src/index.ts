#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createWriteStream, existsSync, readFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { PORT, bridgeInfo, call, cdp, loadToken, sleep, startBridge } from "./bridge.js";
import { st, waitForEvent } from "./state.js";
import { takeSnapshot } from "./snapshot.js";
import {
  backendId, bbox, clickAt, clickUid, dragUid, fillUid, hoverUid, pressKey, typeText, uploadFiles, waitForLoad, resolveObject,
} from "./input.js";
import { analyzeTrace, Analysis } from "./perf.js";

// Small CLI helpers: `chrome-control-mcp token` and `chrome-control-mcp extension`
const cmd = process.argv[2];
const HELP = `chrome-control-mcp: let Claude control your Chrome.

Usage: chrome-control-mcp <command>

  setup        One-time install: native host, extension copy, Claude config. Opens chrome://extensions.
               Options: --no-claude, --no-claude-desktop, --no-claude-code, --no-open, --force, --extension-id <id>
  serve        Run one shared server for many clients (http://127.0.0.1:8766/mcp)
  url          Print the shared server URL with its token
  token        Print the secret token
  extension    Print the folder to load in chrome://extensions
  uninstall    Remove the native host and the extension copy
  version      Print the version
  help         Show this help

With no command, it runs as an MCP server over stdio (what Claude launches).`;
if (cmd === "help" || cmd === "--help" || cmd === "-h" || (cmd === undefined && process.stdin.isTTY)) {
  console.log(HELP);
  process.exit(0);
}
if (cmd === "version" || cmd === "--version" || cmd === "-v") {
  console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  process.exit(0);
}
if (cmd === "token") {
  console.log(loadToken());
  process.exit(0);
}
if (cmd === "extension") {
  const stable = join(homedir(), ".chrome-control-mcp", "extension");
  console.log(existsSync(stable) ? stable : fileURLToPath(new URL("../extension", import.meta.url)));
  process.exit(0);
}
if (cmd === "url") {
  console.log(`http://127.0.0.1:${process.env.CHROME_BRIDGE_HTTP_PORT ?? 8766}/mcp?token=${loadToken()}`);
  process.exit(0);
}
if (cmd === "setup" || cmd === "uninstall") {
  try {
    const m = await import("./setup.js");
    if (cmd === "setup") m.runSetup(process.argv.slice(3));
    else m.runUninstall();
    process.exit(0);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

startBridge(loadToken());

// ---------- helpers ----------
type ToolResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
};
const text = (v: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});
const safe =
  (fn: (a: any) => Promise<ToolResult>) =>
  async (a: any): Promise<ToolResult> => {
    try {
      return await fn(a);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  };
const abs = (p: string) => resolve(process.cwd(), p);
function saveFile(p: string, data: string | Buffer) {
  const f = abs(p);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, data);
  return f;
}

let selected: number | null = null;
const QUIET = (script: boolean) =>
  script ? " (Background tab: used script events, not real input. Use select_page with bringToFront=true if the site needs real input.)" : "";
const owned = new Set<number>(); // tabs opened by this MCP

async function listTabs(): Promise<any[]> {
  return call("tabs.list");
}
async function page(a: any): Promise<number> {
  if (a?.pageId != null) return a.pageId;
  if (selected != null) return selected;
  const tabs = await listTabs();
  const t = tabs.find((t) => t.active) ?? tabs[0];
  if (!t) throw new Error("No controllable page found. Open a tab first.");
  selected = t.id;
  return t.id;
}
const attach = (id: number) => call("attach", { tabId: id });
async function withSnapshot(id: number, include: boolean, msg: string): Promise<ToolResult> {
  if (!include) return text(msg);
  return text(`${msg}\n## Latest page snapshot\n${await takeSnapshot(id)}`);
}
async function evalJs(id: number, expression: string): Promise<any> {
  const r: any = await cdp(id, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "Evaluation failed");
  return r.result?.value;
}
function paginate<T>(items: T[], pageIdx?: number, pageSize?: number): { slice: T[]; note: string } {
  if (!pageSize) return { slice: items, note: `Showing all ${items.length} item(s).` };
  const i = pageIdx ?? 0;
  const slice = items.slice(i * pageSize, (i + 1) * pageSize);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  return { slice, note: `Showing ${slice.length} of ${items.length} item(s). Page ${i + 1} of ${pages}.` };
}
const norm = (u: string) => {
  try {
    const x = new URL(u);
    x.hash = "";
    const s = x.toString();
    return s.endsWith("/") ? s.slice(0, -1) : s;
  } catch {
    return u;
  }
};
const originOf = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
};

// One McpServer per client session, so several clients can use the same bridge at once.
function buildServer(): McpServer {
const server = new McpServer({ name: "chrome-control", version: "0.2.0" });
const pageId = z.number().optional().describe("Targets a specific page by ID. Defaults to the selected page.");
const includeSnapshot = z.boolean().optional().describe("Whether to include a snapshot in the response. Default is false.");

// ---------- bridge status ----------
server.tool("status", "Is the Chrome extension connected? Also shows if this MCP instance owns the port or shares it as a peer.", {}, safe(async () => {
  const i = await bridgeInfo();
  return text({ connected: i.extension, ...i, port: PORT, selectedPage: selected });
}));

server.tool("cdp", "Send any raw Chrome DevTools Protocol command to a page.", {
  pageId, method: z.string().describe("e.g. DOM.getDocument"), params: z.record(z.any()).default({}),
}, safe(async (a) => text(await cdp(await page(a), a.method, a.params))));

server.tool("reload_bridge_extension", "Reload the Chrome Control extension (use after updating its files).", {}, safe(async () => text(await call("ext.reload"))));

// ---------- navigation ----------
server.tool("list_pages", "Get a list of pages open in the browser.", {}, safe(async () => {
  const tabs = await listTabs();
  if (!tabs.length) return text("No pages available.");
  return text("## Pages\n" + tabs.map((t) => `${t.id}: ${t.title} (${t.url})${t.id === selected ? " [selected]" : ""}${owned.has(t.id) ? " [opened by MCP]" : ""}${t.active ? " [active in browser]" : ""}`).join("\n"));
}));

server.tool("select_page", "Select a page as a context for future tool calls.", {
  pageId: z.number(), bringToFront: z.boolean().optional().describe("Whether to focus the page and bring it to the top."),
}, safe(async (a) => {
  selected = a.pageId;
  await attach(a.pageId);
  if (a.bringToFront) await call("tabs.focus", { tabId: a.pageId });
  return text(`Selected page ${a.pageId}.`);
}));

server.tool("new_page", "Open a page. It first looks for an already open tab: same URL is reused as is, same site is reused and navigated. A new background tab is opened only if none exists.", {
  url: z.string().describe("URL to load in a new page."),
  background: z.boolean().optional().describe("Open in the background without bringing it to the front. Default is true."),
  forceNew: z.boolean().optional().describe("Skip the tab reuse check and always open a new tab."),
  isolatedContext: z.string().optional().describe("Not supported by the extension bridge. Ignored."),
  timeout: z.number().optional(),
}, safe(async (a) => {
  const bg = a.background !== false;
  const tabs = await listTabs();
  if (!a.forceNew) {
    const exact = tabs.find((t) => norm(t.url) === norm(a.url));
    if (exact) {
      selected = exact.id;
      await attach(exact.id);
      if (!bg) await call("tabs.focus", { tabId: exact.id });
      return text(`Reused existing tab ${exact.id}, already open at this URL. No new tab was opened.`);
    }
    const same = tabs.filter((t) => originOf(t.url) === originOf(a.url) && originOf(a.url) !== "");
    const pick = same.find((t) => owned.has(t.id)) ?? same.find((t) => !t.active) ?? same[0];
    if (pick) {
      selected = pick.id;
      const s = st(pick.id);
      await attach(pick.id);
      s.autoBeforeUnload = "accept";
      const r: any = await cdp(pick.id, "Page.navigate", { url: a.url });
      if (r.errorText) throw new Error(`Navigation failed: ${r.errorText}`);
      const loaded = await waitForLoad(pick.id, a.timeout || 30000);
      s.autoBeforeUnload = null;
      if (!bg) await call("tabs.focus", { tabId: pick.id });
      return text(`Reused existing tab ${pick.id} from the same site and navigated it to ${a.url}.${loaded ? "" : " Page was still loading when the wait ended."}`);
    }
  }
  const t = await call("tabs.create", { url: a.url, active: !bg });
  owned.add(t.id);
  selected = t.id;
  await attach(t.id);
  const loaded = await waitForLoad(t.id, a.timeout || 30000);
  return text(`Opened new tab ${t.id} at ${a.url}.${loaded ? "" : " Page was still loading when the wait ended."}`);
}));

server.tool("close_page", "Closes a page by its ID. Only tabs opened by this MCP can be closed unless force is true.", {
  pageId: z.number(), force: z.boolean().optional().describe("Allow closing a tab the user opened."),
}, safe(async (a) => {
  if (!owned.has(a.pageId) && !a.force) {
    return text("Refused: this tab was not opened by the MCP, so it may hold the user's work. Pass force=true if you really want to close it.");
  }
  await call("tabs.close", { tabId: a.pageId });
  owned.delete(a.pageId);
  if (selected === a.pageId) selected = null;
  return text(`Closed page ${a.pageId}.`);
}));

server.tool("navigate_page", "Go to a URL, or back, forward, or reload.", {
  pageId,
  type: z.enum(["url", "back", "forward", "reload"]).optional(),
  url: z.string().optional().describe("Target URL (only type=url)"),
  ignoreCache: z.boolean().optional(),
  handleBeforeUnload: z.enum(["accept", "dismiss"]).optional(),
  initScript: z.string().optional().describe("JavaScript to run on each new document before other scripts for the next navigation."),
  timeout: z.number().optional(),
}, safe(async (a) => {
  const id = await page(a);
  await attach(id);
  const s = st(id);
  const type = a.type ?? "url";
  s.autoBeforeUnload = a.handleBeforeUnload ?? "accept";
  let scriptId: string | undefined;
  try {
    if (a.initScript) scriptId = ((await cdp(id, "Page.addScriptToEvaluateOnNewDocument", { source: a.initScript })) as any).identifier;
    if (type === "url") {
      if (!a.url) throw new Error("url is required when type is url");
      const r: any = await cdp(id, "Page.navigate", { url: a.url });
      if (r.errorText) throw new Error(`Navigation failed: ${r.errorText}`);
    } else if (type === "reload") {
      await cdp(id, "Page.reload", { ignoreCache: !!a.ignoreCache });
    } else {
      const h: any = await cdp(id, "Page.getNavigationHistory");
      const idx = h.currentIndex + (type === "back" ? -1 : 1);
      const entry = h.entries[idx];
      if (!entry) throw new Error(`No history entry to go ${type}`);
      await cdp(id, "Page.navigateToHistoryEntry", { entryId: entry.id });
    }
    const loaded = await waitForLoad(id, a.timeout || 30000);
    return text(`Navigation (${type}) done.${loaded ? "" : " Page was still loading when the wait ended."}`);
  } finally {
    s.autoBeforeUnload = null;
    if (scriptId) cdp(id, "Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId }).catch(() => {});
  }
}));

server.tool("wait_for", "Wait for the specified text to appear on the selected page.", {
  pageId, text: z.array(z.string()).min(1).describe("Resolves when any value appears on the page."), timeout: z.number().optional(),
}, safe(async (a) => {
  const id = await page(a);
  const deadline = Date.now() + (a.timeout || 30000);
  const expr = `(() => { const t = (document.body && document.body.innerText) || ''; const list = ${JSON.stringify(a.text)}; return list.find(x => t.includes(x)) ?? null; })()`;
  while (Date.now() < deadline) {
    const hit = await evalJs(id, expr);
    if (hit) return text(`Element with text "${hit}" found.`);
    await sleep(250);
  }
  throw new Error(`Timed out waiting for: ${a.text.join(", ")}`);
}));

// ---------- debugging: snapshot, screenshot, script ----------
server.tool("take_snapshot", "Take a text snapshot of the page based on the a11y tree. Lists elements with a unique uid. Always use the latest snapshot. Prefer this over a screenshot.", {
  pageId, verbose: z.boolean().optional(), filePath: z.string().optional(),
}, safe(async (a) => {
  const id = await page(a);
  await attach(id);
  const snap = await takeSnapshot(id, !!a.verbose);
  if (a.filePath) return text(`Snapshot saved to ${saveFile(a.filePath, snap)}`);
  return text(`## Latest page snapshot\n${snap}`);
}));

server.tool("take_screenshot", "Take a screenshot of the page or element.", {
  pageId,
  format: z.enum(["png", "jpeg", "webp"]).optional(),
  quality: z.number().optional(),
  fullPage: z.boolean().optional().describe("Full page instead of viewport. Incompatible with uid."),
  uid: z.string().optional().describe("Element uid from the latest snapshot."),
  filePath: z.string().optional(),
}, safe(async (a) => {
  const id = await page(a);
  const fmt = a.format ?? "png";
  const params: any = { format: fmt };
  if (fmt !== "png" && a.quality != null) params.quality = a.quality;
  if (a.uid) {
    const b = await bbox(id, backendId(id, a.uid));
    const sc: any = await evalJs(id, "({x: window.scrollX, y: window.scrollY})");
    params.clip = { x: b.x + sc.x, y: b.y + sc.y, width: b.width, height: b.height, scale: 1 };
  } else if (a.fullPage) {
    const m: any = await cdp(id, "Page.getLayoutMetrics");
    const sz = m.cssContentSize ?? m.contentSize;
    params.captureBeyondViewport = true;
    params.clip = { x: 0, y: 0, width: sz.width, height: sz.height, scale: 1 };
  }
  const r: any = await cdp(id, "Page.captureScreenshot", params, 60000);
  if (a.filePath) return text(`Saved screenshot to ${saveFile(a.filePath, Buffer.from(r.data, "base64"))}`);
  return { content: [{ type: "text", text: `Took a screenshot of the ${a.uid ? "element" : a.fullPage ? "full page" : "viewport"}.` }, { type: "image", data: r.data, mimeType: `image/${fmt}` }] };
}));

server.tool("evaluate_script", "Evaluate a JavaScript function inside the page. Returns the result as JSON.", {
  pageId,
  function: z.string().describe("A JavaScript function declaration. Example: () => document.title, or (el) => el.innerText"),
  args: z.array(z.string()).optional().describe("Element uids from the latest snapshot, passed as function arguments."),
  dialogAction: z.string().optional().describe('"accept", "dismiss", or text for window.prompt. Defaults to accept.'),
  filePath: z.string().optional(),
  waitForStableDom: z.boolean().optional(),
}, safe(async (a) => {
  const id = await page(a);
  await attach(id);
  const s = st(id);
  s.autoDialog = a.dialogAction === "dismiss" ? { accept: false } : a.dialogAction && a.dialogAction !== "accept" ? { accept: true, promptText: a.dialogAction } : { accept: true };
  try {
    const g: any = await cdp(id, "Runtime.evaluate", { expression: "globalThis", returnByValue: false });
    const argv: any[] = [];
    for (const u of a.args ?? []) argv.push({ objectId: await resolveObject(id, backendId(id, u)) });
    const r: any = await cdp(id, "Runtime.callFunctionOn", {
      objectId: g.result.objectId, functionDeclaration: a.function, arguments: argv, returnByValue: true, awaitPromise: true, userGesture: true,
    }, 60000);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    if (a.waitForStableDom !== false) await sleep(150);
    const out = JSON.stringify(r.result?.value ?? null, null, 2);
    if (a.filePath) return text(`Output saved to ${saveFile(a.filePath, out)}`);
    return text(`Script ran on page and returned:\n\`\`\`json\n${out}\n\`\`\``);
  } finally {
    s.autoDialog = null;
  }
}));

// ---------- input automation ----------
server.tool("click", "Clicks on the provided element", {
  pageId, uid: z.string(), dblClick: z.boolean().optional(), includeSnapshot,
}, safe(async (a) => {
  const id = await page(a);
  const script = await clickUid(id, a.uid, !!a.dblClick);
  await sleep(100);
  return withSnapshot(id, !!a.includeSnapshot, `Successfully clicked on the element${a.dblClick ? " (double click)" : ""}.${QUIET(script)}`);
}));

server.tool("click_at", "Clicks at the provided coordinates (CSS pixels in the viewport).", {
  pageId, x: z.number(), y: z.number(), dblClick: z.boolean().optional(), includeSnapshot,
}, safe(async (a) => {
  const id = await page(a);
  const script = await clickAt(id, a.x, a.y, !!a.dblClick);
  return withSnapshot(id, !!a.includeSnapshot, `Successfully clicked at (${a.x}, ${a.y}).${QUIET(script)}`);
}));

server.tool("hover", "Hover over the provided element", { pageId, uid: z.string(), includeSnapshot }, safe(async (a) => {
  const id = await page(a);
  const script = await hoverUid(id, a.uid);
  return withSnapshot(id, !!a.includeSnapshot, `Successfully hovered over the element.${QUIET(script)}`);
}));

server.tool("drag", "Drag an element onto another element", {
  pageId, from_uid: z.string(), to_uid: z.string(), includeSnapshot,
}, safe(async (a) => {
  const id = await page(a);
  await dragUid(id, a.from_uid, a.to_uid);
  return withSnapshot(id, !!a.includeSnapshot, "Successfully dragged the element.");
}));

server.tool("fill", "Type text into an input, text area or select an option from a <select> element.", {
  pageId, uid: z.string(), value: z.string().describe('"true" or "false" for checkboxes and toggles, "true" for radio buttons.'), includeSnapshot,
}, safe(async (a) => {
  const id = await page(a);
  await fillUid(id, a.uid, a.value);
  return withSnapshot(id, !!a.includeSnapshot, "Successfully filled out the element.");
}));

server.tool("fill_form", "Fill out multiple form elements (inputs, selects, checkboxes, radios) at once. Prefer this over many fill calls.", {
  pageId, elements: z.array(z.object({ uid: z.string(), value: z.string() })), includeSnapshot,
}, safe(async (a) => {
  const id = await page(a);
  for (const e of a.elements) await fillUid(id, e.uid, e.value);
  return withSnapshot(id, !!a.includeSnapshot, `Successfully filled ${a.elements.length} element(s).`);
}));

server.tool("type_text", "Type text using the keyboard into a previously focused input", {
  pageId, text: z.string(), submitKey: z.string().optional().describe('Optional key to press after typing, e.g. "Enter"'),
}, safe(async (a) => {
  const id = await page(a);
  let script = await typeText(id, a.text);
  if (a.submitKey) script = (await pressKey(id, a.submitKey)) || script;
  return text(`Typed text${a.submitKey ? ` and pressed ${a.submitKey}` : ""}.${QUIET(script)}`);
}));

server.tool("press_key", 'Press a key or key combination, e.g. "Enter", "Control+A", "Control+Shift+R". Modifiers: Control, Shift, Alt, Meta.', {
  pageId, key: z.string(), includeSnapshot,
}, safe(async (a) => {
  const id = await page(a);
  const script = await pressKey(id, a.key);
  return withSnapshot(id, !!a.includeSnapshot, `Successfully pressed key: ${a.key}${script ? "." + QUIET(script) : ""}`);
}));

server.tool("upload_file", "Upload a file through a file input, or an element that opens a file chooser.", {
  pageId, uid: z.string(), filePaths: z.array(z.string()).describe("Paths local to the computer running Chrome."), includeSnapshot,
}, safe(async (a) => {
  const id = await page(a);
  await uploadFiles(id, a.uid, a.filePaths);
  return withSnapshot(id, !!a.includeSnapshot, `File upload done (${a.filePaths.length} file(s)).`);
}));

server.tool("handle_dialog", "If a browser dialog was opened, use this to handle it", {
  pageId, action: z.enum(["accept", "dismiss"]), promptText: z.string().optional(),
}, safe(async (a) => {
  const id = await page(a);
  const d = st(id).dialog;
  if (!d) throw new Error("No open dialog found");
  await cdp(id, "Page.handleJavaScriptDialog", { accept: a.action === "accept", ...(a.promptText !== undefined ? { promptText: a.promptText } : {}) });
  return text(`Successfully ${a.action === "accept" ? "accepted" : "dismissed"} the ${d.type} dialog.`);
}));

// ---------- console ----------
server.tool("list_console_messages", "List console messages for the page since the last navigation.", {
  pageId,
  types: z.array(z.string()).optional(),
  includePreservedMessages: z.boolean().optional().describe("Include messages from the last 3 navigations."),
  includeStackTraces: z.boolean().optional(),
  pageIdx: z.number().optional(), pageSize: z.number().optional(),
  serviceWorkerId: z.string().optional().describe("Not supported. Ignored."),
}, safe(async (a) => {
  const id = await page(a);
  await attach(id);
  const s = st(id);
  let msgs = a.includePreservedMessages ? s.buckets.flatMap((b) => b.console) : s.cur().console;
  if (a.types?.length) msgs = msgs.filter((m) => a.types.includes(m.type));
  const { slice, note } = paginate(msgs, a.pageIdx, a.pageSize);
  const body = slice.map((m) => `msgid=${m.msgid} [${m.type}] ${m.text} (${m.argCount} args)${a.includeStackTraces && m.stack ? "\n" + m.stack : ""}`).join("\n");
  return text(`## Console messages\n${slice.length ? body : "<no console messages found>"}\n${note}`);
}));

server.tool("get_console_message", "Gets a console message by its ID.", { pageId, msgid: z.number() }, safe(async (a) => {
  const id = await page(a);
  const m = st(id).buckets.flatMap((b) => b.console).find((m) => m.msgid === a.msgid);
  if (!m) throw new Error(`Console message ${a.msgid} not found`);
  return text(`msgid=${m.msgid}\ntype: ${m.type}\ntime: ${new Date(m.t).toISOString()}\ntext: ${m.text}\n${m.stack ? "stack:\n" + m.stack : "stack: <none>"}`);
}));

// ---------- network ----------
server.tool("list_network_requests", "Lists the most recent requests for the page since the last navigation.", {
  pageId,
  resourceTypes: z.array(z.string()).optional(),
  includePreservedRequests: z.boolean().optional().describe("Include requests from the last 3 navigations."),
  pageIdx: z.number().optional(), pageSize: z.number().optional(),
}, safe(async (a) => {
  const id = await page(a);
  await attach(id);
  const s = st(id);
  let reqs = a.includePreservedRequests ? s.buckets.flatMap((b) => b.network) : s.cur().network;
  if (a.resourceTypes?.length) {
    const want = a.resourceTypes.map((t: string) => t.toLowerCase());
    reqs = reqs.filter((r) => want.includes((r.type ?? "").toLowerCase()));
  }
  const { slice, note } = paginate(reqs, a.pageIdx, a.pageSize);
  const body = slice.map((r) => `reqid=${r.reqid} ${r.method} ${r.url} [${r.failed ? `failed: ${r.failed}` : r.status ?? "pending"}]`).join("\n");
  return text(`## Network requests\n${slice.length ? body : "<no requests found>"}\n${note}`);
}));

server.tool("get_network_request", "Gets a network request by reqid (the latest request if omitted). Includes headers and bodies.", {
  pageId, reqid: z.number().optional(), requestFilePath: z.string().optional(), responseFilePath: z.string().optional(),
}, safe(async (a) => {
  const id = await page(a);
  const all = st(id).buckets.flatMap((b) => b.network);
  const r = a.reqid != null ? all.find((x) => x.reqid === a.reqid) : all[all.length - 1];
  if (!r) throw new Error(a.reqid != null ? `Request ${a.reqid} not found` : "No requests recorded");
  const hdr = (h?: Record<string, string>) => (h ? Object.entries(h).map(([k, v]) => `  ${k}: ${v}`).join("\n") : "  <none>");
  let reqBody = r.postData ?? "";
  if (!reqBody && r.hasPostData) reqBody = ((await cdp(id, "Network.getRequestPostData", { requestId: r.requestId }).catch(() => ({}))) as any).postData ?? "";
  let resBody = "";
  let resNote = "";
  if (r.finished && !r.failed) {
    try {
      const b: any = await cdp(id, "Network.getResponseBody", { requestId: r.requestId });
      resBody = b.base64Encoded ? `<binary, ${b.body.length} base64 chars>` : b.body;
      if (a.responseFilePath) resNote = `\nResponse body saved to ${saveFile(a.responseFilePath, b.base64Encoded ? Buffer.from(b.body, "base64") : b.body)}`;
    } catch (e) {
      resBody = `<unavailable: ${(e as Error).message}>`;
    }
  }
  if (a.requestFilePath && reqBody) resNote += `\nRequest body saved to ${saveFile(a.requestFilePath, reqBody)}`;
  const trunc = (s: string) => (s.length > 20000 ? s.slice(0, 20000) + "\n... [truncated]" : s);
  return text(
    `## Request reqid=${r.reqid}\n${r.method} ${r.url}\nType: ${r.type ?? "?"}\nStatus: ${r.failed ? `failed (${r.failed})` : `${r.status ?? "pending"} ${r.statusText ?? ""}`}\nMIME: ${r.mime ?? "?"}\nSize: ${r.size ?? "?"} bytes\n\n### Request headers\n${hdr(r.requestHeaders)}\n### Request body\n${a.requestFilePath ? "<saved to file>" : trunc(reqBody) || "<none>"}\n\n### Response headers\n${hdr(r.responseHeaders)}\n### Response body\n${a.responseFilePath ? "<saved to file>" : trunc(resBody) || "<none>"}${resNote}`
  );
}));

// ---------- emulation ----------
const NETWORK: Record<string, any> = {
  Offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  "Slow 3G": { offline: false, latency: 2000, downloadThroughput: (500 * 1024) / 8 * 0.8, uploadThroughput: (500 * 1024) / 8 * 0.8 },
  "Fast 3G": { offline: false, latency: 562.5, downloadThroughput: (1.6 * 1024 * 1024) / 8 * 0.9, uploadThroughput: (750 * 1024) / 8 * 0.9 },
  "Slow 4G": { offline: false, latency: 562.5, downloadThroughput: (1.6 * 1024 * 1024) / 8 * 0.9, uploadThroughput: (750 * 1024) / 8 * 0.9 },
  "Fast 4G": { offline: false, latency: 170, downloadThroughput: (9 * 1024 * 1024) / 8 * 0.9, uploadThroughput: (9 * 1024 * 1024) / 8 * 0.9 },
};
server.tool("emulate", "Emulates various features on the page. Settings last until the debugger detaches.", {
  pageId,
  colorScheme: z.enum(["dark", "light", "auto"]).optional(),
  cpuThrottlingRate: z.number().optional(),
  extraHttpHeaders: z.string().optional().describe("JSON object string. Empty string clears."),
  geolocation: z.string().optional().describe("latitude,longitude"),
  networkConditions: z.enum(["Offline", "Slow 3G", "Fast 3G", "Slow 4G", "Fast 4G"]).optional(),
  userAgent: z.string().optional().describe("Empty string clears the override."),
  viewport: z.string().optional().describe("<width>x<height>x<devicePixelRatio>[,mobile][,touch][,landscape]"),
}, safe(async (a) => {
  const id = await page(a);
  await attach(id);
  const done: string[] = [];
  if (a.colorScheme) {
    await cdp(id, "Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: a.colorScheme === "auto" ? "" : a.colorScheme }] });
    done.push(`colorScheme=${a.colorScheme}`);
  }
  if (a.cpuThrottlingRate != null) {
    await cdp(id, "Emulation.setCPUThrottlingRate", { rate: a.cpuThrottlingRate });
    done.push(`cpuThrottlingRate=${a.cpuThrottlingRate}`);
  }
  if (a.extraHttpHeaders !== undefined) {
    await cdp(id, "Network.setExtraHTTPHeaders", { headers: a.extraHttpHeaders ? JSON.parse(a.extraHttpHeaders) : {} });
    done.push("extraHttpHeaders");
  }
  if (a.geolocation !== undefined) {
    if (a.geolocation === "") await cdp(id, "Emulation.clearGeolocationOverride");
    else {
      const [lat, lon] = a.geolocation.split(",").map(Number);
      if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) throw new Error("Invalid geolocation. Use <latitude>,<longitude>.");
      await cdp(id, "Emulation.setGeolocationOverride", { latitude: lat, longitude: lon, accuracy: 100 });
    }
    done.push("geolocation");
  }
  if (a.networkConditions) {
    await cdp(id, "Network.emulateNetworkConditions", NETWORK[a.networkConditions]);
    done.push(`networkConditions=${a.networkConditions}`);
  }
  if (a.userAgent !== undefined) {
    await cdp(id, "Emulation.setUserAgentOverride", { userAgent: a.userAgent });
    done.push("userAgent");
  }
  if (a.viewport) {
    const [dims, ...flags] = a.viewport.split(",");
    const [w, h, dpr] = dims.split("x").map(Number);
    if (!w || !h) throw new Error("Invalid viewport. Use <width>x<height>x<devicePixelRatio>[,mobile][,touch][,landscape]");
    const landscape = flags.includes("landscape");
    await cdp(id, "Emulation.setDeviceMetricsOverride", {
      width: w, height: h, deviceScaleFactor: dpr || 1, mobile: flags.includes("mobile"),
      screenOrientation: { type: landscape ? "landscapePrimary" : "portraitPrimary", angle: landscape ? 90 : 0 },
    });
    await cdp(id, "Emulation.setTouchEmulationEnabled", { enabled: flags.includes("touch") || flags.includes("mobile") });
    done.push(`viewport=${a.viewport}`);
  }
  return text(done.length ? `Emulation applied: ${done.join(", ")}` : "Nothing to emulate. Pass at least one option.");
}));

server.tool("resize_page", "Resizes the page's window so that the page has the specified dimension", {
  pageId, width: z.number(), height: z.number(),
}, safe(async (a) => {
  const id = await page(a);
  const d: any = await evalJs(id, "({dw: window.outerWidth - window.innerWidth, dh: window.outerHeight - window.innerHeight})");
  await call("window.resize", { tabId: id, width: Math.round(a.width + d.dw), height: Math.round(a.height + d.dh) });
  return text(`Resized the window so the page is about ${a.width}x${a.height}.`);
}));

// ---------- performance ----------
const lastAnalysis = new Map<number, Analysis>();
const TRACE_CATEGORIES =
  "-*,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,loading,latencyInfo,blink.user_timing,v8.execute,toplevel,navigation,rail,blink.console";

async function stopTrace(id: number, filePath?: string): Promise<string> {
  const s = st(id);
  if (!s.traceActive) throw new Error("No active trace on this page");
  const done = waitForEvent(id, "Tracing.tracingComplete", 90000);
  await cdp(id, "Tracing.end", {}, 60000);
  const ev = await done;
  s.traceActive = false;
  if (!ev) throw new Error("Timed out waiting for the trace to finish");
  const events = s.traceEvents;
  s.traceEvents = [];
  const analysis = analyzeTrace(events);
  lastAnalysis.set(id, analysis);
  let saved = "";
  const target = filePath ?? s.traceFile;
  if (target) {
    const json = JSON.stringify({ traceEvents: events });
    saved = `\nRaw trace saved to ${saveFile(target, target.endsWith(".gz") ? gzipSync(json) : json)}`;
  }
  return `The performance trace has been stopped (${events.length} events).\n## Summary\n${analysis.summary}\n\n## Available insight sets\n- id: NAVIGATION_0, insights: ${Object.keys(analysis.insights).join(", ")}\nNote: this is a lightweight analysis of the raw trace, not the full DevTools trace engine.${saved}`;
}

server.tool("performance_start_trace", "Start a performance trace on the page. Use to find frontend performance issues and Core Web Vitals.", {
  pageId, reload: z.boolean().optional(), autoStop: z.boolean().optional(), filePath: z.string().optional(),
}, safe(async (a) => {
  const id = await page(a);
  await attach(id);
  const s = st(id);
  if (s.traceActive) throw new Error("A trace is already running on this page. Stop it first.");
  s.traceEvents = [];
  s.traceFile = a.filePath;
  s.traceActive = true;
  try {
    await cdp(id, "Tracing.start", { categories: TRACE_CATEGORIES, transferMode: "ReportEvents" });
  } catch (e) {
    s.traceActive = false;
    throw new Error(`Could not start tracing through the extension: ${(e as Error).message}`);
  }
  if (a.reload) await cdp(id, "Page.reload", { ignoreCache: false });
  if (a.autoStop) {
    await waitForLoad(id, 45000);
    await sleep(3000);
    return text(await stopTrace(id, a.filePath));
  }
  return text("The performance trace is being recorded. Use performance_stop_trace to stop it.");
}));

server.tool("performance_stop_trace", "Stop the active performance trace on the page.", { pageId, filePath: z.string().optional() }, safe(async (a) => {
  return text(await stopTrace(await page(a), a.filePath));
}));

server.tool("performance_analyze_insight", "More detail on a specific insight from the last trace.", {
  pageId, insightSetId: z.string(), insightName: z.string(),
}, safe(async (a) => {
  const id = await page(a);
  const an = lastAnalysis.get(id);
  if (!an) throw new Error("No trace analysis available. Record a trace first.");
  const out = an.insights[a.insightName];
  if (!out) throw new Error(`Unknown insight "${a.insightName}". Available: ${Object.keys(an.insights).join(", ")}`);
  return text(`## Insight ${a.insightName}\n${out}`);
}));

// ---------- memory ----------
server.tool("take_heapsnapshot", "Capture a heap snapshot of the page to a .heapsnapshot file.", {
  pageId, filePath: z.string().describe("Path to a .heapsnapshot file."),
}, safe(async (a) => {
  const id = await page(a);
  await attach(id);
  const s = st(id);
  const f = abs(a.filePath);
  mkdirSync(dirname(f), { recursive: true });
  const ws = createWriteStream(f);
  s.heapSink = (c) => ws.write(c);
  try {
    await cdp(id, "HeapProfiler.enable");
    await cdp(id, "HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: true }, 300000);
  } finally {
    s.heapSink = null;
    await new Promise<void>((r) => ws.end(() => r()));
  }
  return text(`Heap snapshot saved to ${f} (${(statSync(f).size / 1024 / 1024).toFixed(1)} MB).`);
}));

return server;
}

// ---------- transports ----------
const HTTP_PORT = Number(process.env.CHROME_BRIDGE_HTTP_PORT ?? 8766);

async function serveHttp() {
  const token = loadToken();
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const readBody = (req: IncomingMessage) =>
    new Promise<any>((res, rej) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          res(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
        } catch (e) {
          rej(e);
        }
      });
      req.on("error", rej);
    });
  const fail = (res: ServerResponse, code: number, msg: string) => {
    if (res.headersSent) return;
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: msg }, id: null }));
  };

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      // Local programs only: a website always sends Origin, and Host must be loopback (DNS rebinding).
      if (req.headers.origin) return fail(res, 403, "Forbidden origin");
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host ?? "")) return fail(res, 403, "Forbidden host");
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, sessions: sessions.size, ...(await bridgeInfo()) }));
      }
      if (url.pathname !== "/mcp") return fail(res, 404, "Not found. Use /mcp");
      const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
      if ((bearer ?? url.searchParams.get("token")) !== token) return fail(res, 401, "Unauthorized");

      const sid = req.headers["mcp-session-id"] as string | undefined;
      const body = req.method === "POST" ? await readBody(req) : undefined;
      let transport = sid ? sessions.get(sid) : undefined;
      if (!transport) {
        if (sid) return fail(res, 404, "Unknown session. Reconnect.");
        if (req.method !== "POST" || !isInitializeRequest(body)) return fail(res, 400, "Send an initialize request first");
        const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, t);
            console.error(`[http] client connected (${sessions.size} active)`);
          },
        });
        t.onclose = () => {
          if (t.sessionId) sessions.delete(t.sessionId);
          console.error(`[http] client disconnected (${sessions.size} active)`);
        };
        await buildServer().connect(t);
        transport = t;
      }
      await transport.handleRequest(req, res, body);
    } catch (e) {
      console.error("[http] error:", (e as Error).message);
      fail(res, 500, (e as Error).message);
    }
  });
  httpServer.on("error", (e: any) => {
    console.error(e.code === "EADDRINUSE" ? `[http] port ${HTTP_PORT} is already in use. Is the server already running?` : `[http] ${e.message}`);
    process.exit(1);
  });
  httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
    console.error(`[http] chrome-control MCP server: http://127.0.0.1:${HTTP_PORT}/mcp?token=${token}`);
    console.error(`[bridge] Extension port: ${PORT}. Many clients can connect to the URL above at the same time.`);
  });
}

if (cmd === "serve") {
  await serveHttp();
} else {
  await buildServer().connect(new StdioServerTransport());
  console.error(`[bridge] MCP ready. Extension port: ${PORT}. Run "chrome-control-mcp token" to see the token.`);
}
