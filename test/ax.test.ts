import { expect, it } from "vitest";
import { formatAxTree, type AXNode } from "../src/ax";

const node = (nodeId: string, role: string, name: string, childIds: string[] = [], extra: Partial<AXNode> = {}): AXNode => ({
  nodeId,
  role: { value: role },
  name: { value: name },
  childIds,
  ...extra,
});

it("gives refs to interactive elements and drops ignored and duplicate text", () => {
  const { text, refs } = formatAxTree([
    node("1", "RootWebArea", "Page", ["2", "3", "5", "6"]),
    node("2", "heading", "Title"),
    node("3", "button", "Save", ["4"], { backendDOMNodeId: 42 }),
    node("4", "StaticText", "Save"),
    node("5", "StaticText", "secret", [], { ignored: true }),
    node("6", "textbox", "Name", [], {
      backendDOMNodeId: 43,
      value: { value: "Kim" },
      properties: [{ name: "required", value: { value: true } }],
    }),
  ]);
  expect(text).toBe('heading "Title"\n[42] button "Save"\n[43] textbox "Name" value="Kim" (required)');
  expect(refs.get(42)).toEqual({ role: "button", name: "Save" });
  expect(refs.has(5)).toBe(false);
});

it("still visits the children of ignored nodes", () => {
  const { text } = formatAxTree([
    node("1", "RootWebArea", "", ["2"]),
    node("2", "none", "", ["3"], { ignored: true }),
    node("3", "StaticText", "visible"),
  ]);
  expect(text).toBe("visible");
});
