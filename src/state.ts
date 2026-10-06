import { bus, cdp } from "./bridge.js";

let nextMsgId = 1;
let nextReqId = 1;

export interface ConsoleMsg {
  msgid: number;
  type: string;
  text: string;
  argCount: number;
  stack?: string;
  t: number;
}
export interface NetReq {
  reqid: number;
  requestId: string;
  method: string;
  url: string;
  type?: string;
  status?: number;
  statusText?: string;
  mime?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
  hasPostData?: boolean;
  failed?: string;
  finished?: boolean;
  size?: number;
  t: number;
}
interface Bucket {
  console: ConsoleMsg[];
  network: NetReq[];
}

export class TabState {
  buckets: Bucket[] = [{ console: [], network: [] }]; // current + up to 3 preserved navigations
  reqById = new Map<string, NetReq>();
  dialog: { type: string; message: string; defaultPrompt?: string } | null = null;
  autoDialog: { accept: boolean; promptText?: string } | null = null;
  autoBeforeUnload: "accept" | "dismiss" | null = null;
  snapId = 0;
  uids = new Map<string, number>(); // uid -> backendNodeId (-1 = no DOM node)
  traceEvents: any[] = [];
  traceActive = false;
  traceFile?: string;
  heapSink: ((chunk: string) => void) | null = null;
  cur() {
    return this.buckets[this.buckets.length - 1];
  }
}

const states = new Map<number, TabState>();
export function st(tabId: number): TabState {
  let s = states.get(tabId);
  if (!s) {
    s = new TabState();
    states.set(tabId, s);
  }
  return s;
}

function fmtArg(a: any): string {
  if (a.type === "string") return a.value;
  if ("value" in a) return typeof a.value === "object" ? JSON.stringify(a.value) : String(a.value);
  if (a.unserializableValue) return a.unserializableValue;
  if (a.preview?.properties) {
    const props = a.preview.properties.map((p: any) => (a.subtype === "array" ? p.value : `${p.name}: ${p.value}`));
    return a.subtype === "array" ? `[${props.join(", ")}]` : `{${props.join(", ")}}`;
  }
  return a.description ?? a.type;
}
function fmtStack(st: any): string | undefined {
  const frames = st?.callFrames;
  if (!frames?.length) return undefined;
  return frames.map((f: any) => `    at ${f.functionName || "(anonymous)"} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`).join("\n");
}
function pushCapped<T>(arr: T[], item: T, max: number) {
  arr.push(item);
  if (arr.length > max) arr.shift();
}

function handleDialog(tabId: number, accept: boolean, promptText?: string) {
  cdp(tabId, "Page.handleJavaScriptDialog", { accept, ...(promptText !== undefined ? { promptText } : {}) }).catch(() => {});
}

function onEvent(tabId: number, method: string, p: any) {
  const s = st(tabId);
  switch (method) {
    case "Runtime.consoleAPICalled": {
      const args: any[] = p.args ?? [];
      pushCapped(
        s.cur().console,
        {
          msgid: nextMsgId++,
          type: p.type === "warning" ? "warn" : p.type,
          text: args.map(fmtArg).join(" "),
          argCount: args.length,
          stack: fmtStack(p.stackTrace),
          t: Date.now(),
        },
        1000
      );
      break;
    }
    case "Runtime.exceptionThrown": {
      const d = p.exceptionDetails;
      pushCapped(
        s.cur().console,
        {
          msgid: nextMsgId++,
          type: "error",
          text: d.exception?.description ?? d.text,
          argCount: 1,
          stack: fmtStack(d.stackTrace),
          t: Date.now(),
        },
        1000
      );
      break;
    }
    case "Log.entryAdded": {
      const e = p.entry;
      const type = e.level === "warning" ? "warn" : e.level === "verbose" ? "debug" : e.level;
      pushCapped(
        s.cur().console,
        { msgid: nextMsgId++, type, text: `${e.text}${e.url ? ` (${e.url}:${e.lineNumber ?? 0})` : ""}`, argCount: 1, stack: fmtStack(e.stackTrace), t: Date.now() },
        1000
      );
      break;
    }
    case "Network.requestWillBeSent": {
      if (p.redirectResponse) {
        const prev = s.reqById.get(p.requestId);
        if (prev) {
          prev.status = p.redirectResponse.status;
          prev.statusText = p.redirectResponse.statusText;
          prev.responseHeaders = p.redirectResponse.headers;
          prev.finished = true;
        }
      }
      const r: NetReq = {
        reqid: nextReqId++,
        requestId: p.requestId,
        method: p.request.method,
        url: p.request.url,
        type: p.type,
        requestHeaders: p.request.headers,
        postData: p.request.postData,
        hasPostData: p.request.hasPostData,
        t: Date.now(),
      };
      s.reqById.set(p.requestId, r);
      pushCapped(s.cur().network, r, 2000);
      break;
    }
    case "Network.requestWillBeSentExtraInfo": {
      const r = s.reqById.get(p.requestId);
      if (r) r.requestHeaders = { ...r.requestHeaders, ...p.headers };
      break;
    }
    case "Network.responseReceived": {
      const r = s.reqById.get(p.requestId);
      if (r) {
        r.status = p.response.status;
        r.statusText = p.response.statusText;
        r.mime = p.response.mimeType;
        r.responseHeaders = p.response.headers;
        if (p.type) r.type = p.type;
      }
      break;
    }
    case "Network.responseReceivedExtraInfo": {
      const r = s.reqById.get(p.requestId);
      if (r) {
        r.responseHeaders = { ...r.responseHeaders, ...p.headers };
        if (!r.status) r.status = p.statusCode;
      }
      break;
    }
    case "Network.loadingFinished": {
      const r = s.reqById.get(p.requestId);
      if (r) {
        r.finished = true;
        r.size = p.encodedDataLength;
      }
      break;
    }
    case "Network.loadingFailed": {
      const r = s.reqById.get(p.requestId);
      if (r) {
        r.failed = p.errorText;
        r.finished = true;
      }
      break;
    }
    case "Page.frameNavigated": {
      if (p.frame?.parentId) break; // only main frame
      const old = s.cur();
      s.buckets.push({ console: [], network: [] });
      if (s.buckets.length > 4) s.buckets.shift();
      // the document request starts before the navigation commits; move it to the new bucket
      for (let i = old.network.length - 1; i >= 0; i--) {
        const r = old.network[i];
        if (r.type === "Document" && r.url === p.frame.url) {
          old.network.splice(i, 1);
          s.cur().network.push(r);
          break;
        }
      }
      s.uids.clear(); // old uids point to dead nodes
      break;
    }
    case "Page.javascriptDialogOpening": {
      s.dialog = { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt };
      if (s.autoDialog) handleDialog(tabId, s.autoDialog.accept, s.autoDialog.promptText);
      else if (p.type === "beforeunload" && s.autoBeforeUnload) handleDialog(tabId, s.autoBeforeUnload === "accept");
      break;
    }
    case "Page.javascriptDialogClosed":
      s.dialog = null;
      break;
    case "HeapProfiler.addHeapSnapshotChunk":
      s.heapSink?.(p.chunk);
      break;
    case "Tracing.dataCollected":
      if (s.traceActive) for (const e of p.value) s.traceEvents.push(e);
      break;
  }
}

bus.on("cdp", onEvent);
bus.on("disconnected", () => states.clear());

export function waitForEvent(tabId: number, method: string, timeoutMs: number, pred: (p: any) => boolean = () => true): Promise<any | null> {
  return new Promise((resolve) => {
    const h = (t: number, m: string, p: any) => {
      if (t === tabId && m === method && pred(p)) {
        cleanup();
        resolve(p);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const cleanup = () => {
      bus.off("cdp", h);
      clearTimeout(timer);
    };
    bus.on("cdp", h);
  });
}
