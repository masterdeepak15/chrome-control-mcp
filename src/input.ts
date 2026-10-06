import { call, cdp, sleep } from "./bridge.js";
import { st, waitForEvent } from "./state.js";

export function backendId(tabId: number, uid: string): number {
  const id = st(tabId).uids.get(uid);
  if (id === undefined) throw new Error(`Unknown uid "${uid}". The page may have changed. Call take_snapshot again and use the new uids.`);
  if (id < 0) throw new Error(`Element "${uid}" has no DOM node. Pick another element.`);
  return id;
}

async function quad(tabId: number, backendNodeId: number): Promise<number[]> {
  try {
    await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch {}
  const r: any = await cdp(tabId, "DOM.getContentQuads", { backendNodeId });
  const q = (r.quads ?? []).find((q: number[]) => {
    const w = Math.max(q[0], q[2], q[4], q[6]) - Math.min(q[0], q[2], q[4], q[6]);
    const h = Math.max(q[1], q[3], q[5], q[7]) - Math.min(q[1], q[3], q[5], q[7]);
    return w > 0 && h > 0;
  });
  if (!q) throw new Error("Element is not visible or has no layout box");
  return q;
}
export async function center(tabId: number, backendNodeId: number) {
  const q = await quad(tabId, backendNodeId);
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}
export async function bbox(tabId: number, backendNodeId: number) {
  const q = await quad(tabId, backendNodeId);
  const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export async function isHidden(tabId: number): Promise<boolean> {
  const r: any = await cdp(tabId, "Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true });
  return r.result?.value === "hidden";
}

async function callFn(tabId: number, objectId: string, fn: string, args: any[] = []): Promise<any> {
  const r: any = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId, functionDeclaration: fn, arguments: args, returnByValue: true, userGesture: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
}

// Chrome drops real mouse and keyboard input for background tabs (visibilityState "hidden").
// For those tabs we fall back to script events, so the user's screen is never disturbed.
const JS_CLICK = `function(dbl) {
  const el = this;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 };
  const f = (T, t, x) => el.dispatchEvent(new T(t, Object.assign({}, o, x || {})));
  f(PointerEvent, 'pointerdown', { pointerId: 1, isPrimary: true, buttons: 1 });
  f(MouseEvent, 'mousedown', { buttons: 1 });
  if (el.focus) el.focus();
  f(PointerEvent, 'pointerup', { pointerId: 1, isPrimary: true });
  f(MouseEvent, 'mouseup');
  el.click();
  if (dbl) { el.click(); f(MouseEvent, 'dblclick', { detail: 2 }); }
  return true;
}`;
const JS_HOVER = `function() {
  const el = this;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
  for (const [T, t] of [[PointerEvent, 'pointerover'], [PointerEvent, 'pointerenter'], [MouseEvent, 'mouseover'], [MouseEvent, 'mouseenter'], [PointerEvent, 'pointermove'], [MouseEvent, 'mousemove']]) el.dispatchEvent(new T(t, o));
  return true;
}`;

export async function mouseClick(tabId: number, x: number, y: number, dbl = false) {
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  const base = { x, y, button: "left" };
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...base, clickCount: 1 });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base, clickCount: 1 });
  if (dbl) {
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...base, clickCount: 2 });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base, clickCount: 2 });
  }
}
/** Returns true when the script fallback was used (background tab). */
export async function clickAt(tabId: number, x: number, y: number, dbl = false): Promise<boolean> {
  if (await isHidden(tabId)) {
    const g: any = await cdp(tabId, "Runtime.evaluate", { expression: `document.elementFromPoint(${x}, ${y})`, returnByValue: false });
    if (!g.result?.objectId) throw new Error("No element at that point");
    await callFn(tabId, g.result.objectId, JS_CLICK, [{ value: dbl }]);
    return true;
  }
  await mouseClick(tabId, x, y, dbl);
  return false;
}
export async function clickUid(tabId: number, uid: string, dbl = false): Promise<boolean> {
  const bid = backendId(tabId, uid);
  if (await isHidden(tabId)) {
    await callFn(tabId, await resolveObject(tabId, bid), JS_CLICK, [{ value: dbl }]);
    return true;
  }
  const { x, y } = await center(tabId, bid);
  await mouseClick(tabId, x, y, dbl);
  return false;
}
export async function hoverUid(tabId: number, uid: string): Promise<boolean> {
  const bid = backendId(tabId, uid);
  if (await isHidden(tabId)) {
    await callFn(tabId, await resolveObject(tabId, bid), JS_HOVER);
    return true;
  }
  const { x, y } = await center(tabId, bid);
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  return false;
}
export async function dragUid(tabId: number, fromUid: string, toUid: string) {
  if (await isHidden(tabId)) throw new Error("drag needs a visible tab. Call select_page with bringToFront=true first.");
  const a = await center(tabId, backendId(tabId, fromUid));
  const b = await center(tabId, backendId(tabId, toUid));
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x, y: a.y });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: a.x, y: a.y, button: "left", clickCount: 1 });
  for (let i = 1; i <= 8; i++) {
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: a.x + ((b.x - a.x) * i) / 8, y: a.y + ((b.y - a.y) * i) / 8, button: "left", buttons: 1,
    });
    await sleep(15);
  }
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 });
}

export async function resolveObject(tabId: number, backendNodeId: number): Promise<string> {
  const r: any = await cdp(tabId, "DOM.resolveNode", { backendNodeId });
  return r.object.objectId;
}

const FILL_FN = `function(value, quiet) {
  const el = this;
  const fire = (t) => el.dispatchEvent(new Event(t, { bubbles: true }));
  if (el.tagName === 'SELECT') {
    const opt = Array.from(el.options).find(o => o.value === value || o.label === value || o.text.trim() === value);
    if (!opt) throw new Error('Option not found: ' + value);
    el.value = opt.value; fire('input'); fire('change'); return 'select';
  }
  if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
    const want = value === 'true';
    if (el.checked !== want) el.click();
    return 'toggle';
  }
  el.scrollIntoView({ block: 'center' });
  el.focus();
  if (quiet) {
    if (el.isContentEditable) { document.execCommand('selectAll'); document.execCommand('insertText', false, value); return 'done'; }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    fire('input'); fire('change');
    return 'done';
  }
  if (el.isContentEditable) { document.execCommand('selectAll'); return 'text'; }
  if (typeof el.select === 'function') { try { el.select(); } catch (e) {} }
  return 'text';
}`;

export async function fillUid(tabId: number, uid: string, value: string) {
  const objectId = await resolveObject(tabId, backendId(tabId, uid));
  const quiet = await isHidden(tabId);
  const r: any = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId, functionDeclaration: FILL_FN, arguments: [{ value }, { value: quiet }], returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  if (r.result?.value === "text") {
    if (value === "") await pressKey(tabId, "Backspace");
    else await cdp(tabId, "Input.insertText", { text: value });
  }
}

// ---- keyboard ----
const NAMED: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  Esc: { code: "Escape", vk: 27 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  Space: { code: "Space", vk: 32, text: " " },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
  Insert: { code: "Insert", vk: 45 },
};
for (let i = 1; i <= 12; i++) NAMED["F" + i] = { code: "F" + i, vk: 111 + i };
const MODS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Command: 4, Cmd: 4, Shift: 8 };
const EDIT_COMMANDS: Record<string, string> = { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo", y: "redo" };

function splitCombo(combo: string): string[] {
  if (combo === "+") return ["+"];
  if (combo.endsWith("++")) return [...combo.slice(0, -2).split("+"), "+"];
  return combo.split("+");
}

const JS_KEY = `(function(key, mods) {
  const el = document.activeElement || document.body;
  const init = { key: key, bubbles: true, cancelable: true, ctrlKey: !!(mods & 2), shiftKey: !!(mods & 8), altKey: !!(mods & 1), metaKey: !!(mods & 4) };
  const ok = el.dispatchEvent(new KeyboardEvent('keydown', init));
  if (ok) {
    if ((mods & 6) && key.length === 1) {
      const k = key.toLowerCase();
      const cmd = { a: 'selectAll', c: 'copy', x: 'cut', z: 'undo', y: 'redo' }[k];
      if (cmd) document.execCommand(cmd);
    } else if (key === 'Enter') {
      if (el.tagName === 'TEXTAREA' || el.isContentEditable) document.execCommand('insertLineBreak');
      else {
        el.dispatchEvent(new KeyboardEvent('keypress', init));
        if (el.form && el.tagName === 'INPUT') { if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit(); }
        else if (el.tagName === 'BUTTON' || el.tagName === 'A') el.click();
      }
    } else if (key === 'Backspace') document.execCommand('delete');
    else if (key === 'Delete') document.execCommand('forwardDelete');
    else if (key.length === 1 && !(mods & 6)) document.execCommand('insertText', false, key);
  }
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  return true;
})`;

/** Returns true when the script fallback was used (background tab). */
export async function pressKey(tabId: number, combo: string): Promise<boolean> {
  const parts = splitCombo(combo);
  const key = parts[parts.length - 1];
  let modifiers = 0;
  for (const m of parts.slice(0, -1)) {
    if (!(m in MODS)) throw new Error(`Unknown modifier "${m}". Use Control, Shift, Alt or Meta.`);
    modifiers |= MODS[m];
  }
  if (await isHidden(tabId)) {
    await cdp(tabId, "Runtime.evaluate", { expression: `${JS_KEY}(${JSON.stringify(key)}, ${modifiers})`, returnByValue: true });
    return true;
  }
  let info = NAMED[key];
  let keyName = key;
  if (!info) {
    if (key.length !== 1) throw new Error(`Unknown key "${key}"`);
    const up = key.toUpperCase();
    const isLetter = /[a-z]/i.test(key);
    keyName = modifiers & 8 ? up : key.toLowerCase() === key || !isLetter ? key : key;
    info = {
      code: isLetter ? `Key${up}` : /\d/.test(key) ? `Digit${key}` : "",
      vk: isLetter ? up.charCodeAt(0) : key.charCodeAt(0),
      text: key,
    };
  }
  const hasShortcutMod = (modifiers & 7) !== 0;
  const base: any = { modifiers, key: keyName, code: info.code, windowsVirtualKeyCode: info.vk };
  const useText = !!info.text && !hasShortcutMod;
  const down: any = { type: useText ? "keyDown" : "rawKeyDown", ...base };
  if (useText) {
    down.text = info.text;
    down.unmodifiedText = info.text;
  }
  if (hasShortcutMod && key.length === 1 && EDIT_COMMANDS[key.toLowerCase()]) down.commands = [EDIT_COMMANDS[key.toLowerCase()]];
  await cdp(tabId, "Input.dispatchKeyEvent", down);
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  return false;
}

/** Returns true when the script fallback was used (background tab). */
export async function typeText(tabId: number, text: string): Promise<boolean> {
  if (await isHidden(tabId)) {
    const r: any = await cdp(tabId, "Runtime.evaluate", { expression: `document.execCommand('insertText', false, ${JSON.stringify(text)})`, returnByValue: true });
    if (r.result?.value === false) throw new Error("No focused editable element. Use fill or click an input first.");
    return true;
  }
  if (text.length > 300) {
    await cdp(tabId, "Input.insertText", { text });
    return false;
  }
  for (const ch of text) {
    if (ch === "\n") await pressKey(tabId, "Enter");
    else if (/^[\x20-\x7e]$/.test(ch)) {
      const code = /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : /\d/.test(ch) ? `Digit${ch}` : "";
      const base = { key: ch, code, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) };
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...base, text: ch, unmodifiedText: ch });
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
    } else await cdp(tabId, "Input.insertText", { text: ch });
  }
  return false;
}

export async function uploadFiles(tabId: number, uid: string, files: string[]) {
  const bid = backendId(tabId, uid);
  const objectId = await resolveObject(tabId, bid);
  const r: any = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId, functionDeclaration: "function(){ return this.tagName==='INPUT' && this.type==='file'; }", returnByValue: true,
  });
  if (r.result?.value) {
    await cdp(tabId, "DOM.setFileInputFiles", { files, backendNodeId: bid });
    return;
  }
  await cdp(tabId, "Page.setInterceptFileChooserDialog", { enabled: true });
  try {
    const wait = waitForEvent(tabId, "Page.fileChooserOpened", 5000);
    await clickUid(tabId, uid);
    const ev = await wait;
    if (!ev) throw new Error("No file chooser opened after clicking the element");
    await cdp(tabId, "DOM.setFileInputFiles", { files, backendNodeId: ev.backendNodeId });
  } finally {
    await cdp(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
  }
}

export async function waitForLoad(tabId: number, timeoutMs = 30000): Promise<boolean> {
  const start = Date.now();
  await sleep(300);
  while (Date.now() - start < timeoutMs) {
    const t: any = await call("tabs.get", { tabId });
    if (t.status === "complete") return true;
    await sleep(250);
  }
  return false;
}
