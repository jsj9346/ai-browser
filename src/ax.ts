// Turns a CDP accessibility tree into a compact outline for the model.
// Elements the browser hides from assistive tech (e.g. display:none) are left out.

export interface AXValue {
  value?: unknown;
}
export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface RefInfo {
  role: string;
  name: string;
}

const INTERACTIVE = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch",
  "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "slider", "spinbutton",
  "listbox", "treeitem",
]);
const STRUCTURAL = new Set([
  "none", "generic", "InlineTextBox", "LineBreak", "paragraph", "group", "Section", "ListMarker",
  "RootWebArea", "list", "listitem", "LabelText",
]);
const STATES = ["checked", "selected", "expanded", "disabled", "required"];
const MAX_TEXT = 300;

const str = (v: AXValue | undefined) => (v?.value == null ? "" : String(v.value).trim());
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

export function formatAxTree(nodes: AXNode[]): { text: string; refs: Map<number, RefInfo> } {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const refs = new Map<number, RefInfo>();
  const lines: string[] = [];

  const walk = (node: AXNode, depth: number, parentLabel: string) => {
    const role = str(node.role);
    const name = str(node.name);
    let childDepth = depth;
    let label = parentLabel;

    if (!node.ignored) {
      const pad = "  ".repeat(depth);
      if (INTERACTIVE.has(role) && node.backendDOMNodeId !== undefined) {
        refs.set(node.backendDOMNodeId, { role, name });
        const value = str(node.value);
        const states = (node.properties ?? [])
          .filter((p) => STATES.includes(p.name) && p.value.value && p.value.value !== "false")
          .map((p) => p.name);
        lines.push(
          `${pad}[${node.backendDOMNodeId}] ${role} ${JSON.stringify(clip(name))}` +
            (value ? ` value=${JSON.stringify(clip(value))}` : "") +
            (states.length ? ` (${states.join(", ")})` : ""),
        );
        childDepth = depth + 1;
        label = name;
      } else if (role === "StaticText") {
        if (name && !parentLabel.includes(name)) lines.push(`${pad}${clip(name)}`);
      } else if (!STRUCTURAL.has(role) && role) {
        lines.push(`${pad}${role}${name ? ` ${JSON.stringify(clip(name))}` : ""}`);
        childDepth = depth + 1;
        label = name;
      }
    }

    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) walk(child, childDepth, label);
    }
  };

  const root = nodes[0];
  if (root) walk(root, 0, "");
  return { text: lines.join("\n"), refs };
}
