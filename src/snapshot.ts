import { cdp } from "./bridge.js";
import { st } from "./state.js";

const PROPS = [
  "level", "checked", "pressed", "expanded", "selected", "disabled", "required", "readonly", "invalid",
  "multiline", "multiselectable", "modal", "hasPopup", "autocomplete", "orientation", "valuemin", "valuemax", "valuetext", "url", "keyshortcuts",
];
const FLAGS = new Set(["focusable", "focused"]);
const MAX_CHARS = 120000;

export async function takeSnapshot(tabId: number, verbose = false): Promise<string> {
  const r: any = await cdp(tabId, "Accessibility.getFullAXTree", {}, 60000);
  const nodes: any[] = r.nodes ?? [];
  const byId = new Map<string, any>();
  for (const n of nodes) byId.set(n.nodeId, n);
  const root = nodes.find((n) => !n.parentId) ?? nodes[0];
  const s = st(tabId);
  s.snapId++;
  s.uids.clear();
  const snap = s.snapId;
  let counter = 0;
  const lines: string[] = [];

  const walk = (n: any, depth: number, parentName: string) => {
    const role: string = n.role?.value ?? "";
    const name: string = n.name?.value ?? "";
    const kids: string[] = n.childIds ?? [];
    let print = !n.ignored;
    if (role === "InlineTextBox" || role === "LineBreak") print = false;
    if (!verbose && (role === "none" || role === "generic" || role === "") && !name) print = false;
    if (role === "StaticText" && !name.trim()) print = false;
    if (!verbose && role === "StaticText" && name === parentName) print = false; // duplicate of parent label
    if (role === "InlineTextBox") {
      return;
    }
    let nextDepth = depth;
    let nextParentName = parentName;
    if (print) {
      const uid = `${snap}_${counter++}`;
      s.uids.set(uid, n.backendDOMNodeId ?? -1);
      let line = `${"  ".repeat(depth)}uid=${uid} ${role}`;
      if (name) line += ` ${JSON.stringify(name)}`;
      const val = n.value?.value;
      if (val !== undefined && val !== "") line += ` value=${JSON.stringify(String(val))}`;
      const props: Record<string, any> = {};
      for (const p of n.properties ?? []) props[p.name] = p.value?.value;
      for (const k of PROPS) {
        const v = props[k];
        if (v === undefined || v === "" || (v === false && k !== "checked")) continue;
        line += v === true ? ` ${k}` : ` ${k}=${JSON.stringify(String(v))}`;
      }
      for (const f of FLAGS) if (props[f] === true) line += ` ${f}`;
      lines.push(line);
      nextDepth = depth + 1;
      nextParentName = name;
    }
    for (const id of kids) {
      const c = byId.get(id);
      if (c) walk(c, nextDepth, nextParentName);
    }
  };
  if (root) walk(root, 0, "");
  let out = lines.join("\n");
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS) + "\n... [snapshot truncated. Use filePath to save the full snapshot]";
  return out;
}
