import { describe, expect, it } from "vitest";
import { blockedInputReason, isSensitiveClick, isSensitiveSubmit, parseWebUrl } from "../src/policy";

describe("parseWebUrl", () => {
  it("accepts only http and https", () => {
    expect(parseWebUrl("https://example.com/a")?.origin).toBe("https://example.com");
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "chrome://settings", "nope"]) {
      expect(parseWebUrl(bad)).toBeNull();
    }
  });
});

describe("isSensitiveClick", () => {
  it.each(["Delete account", "Place order", "Pay now", "결제하기", "계정 삭제", "보내기"])("flags %s", (name) => {
    expect(isSensitiveClick("button", name)).toBe(true);
  });
  it.each(["Say hello", "Next page", "다음", "Reorder list", "Postcode"])("allows %s", (name) => {
    expect(isSensitiveClick("button", name)).toBe(false);
  });
  it("treats long link text as a headline but keeps checking long button labels", () => {
    const headline = "Why more companies decided to delete their old systems this year";
    expect(isSensitiveClick("link", headline)).toBe(false);
    expect(isSensitiveClick("button", headline)).toBe(true);
  });
});

describe("isSensitiveSubmit", () => {
  it("allows search boxes only", () => {
    expect(isSensitiveSubmit("searchbox")).toBe(false);
    expect(isSensitiveSubmit("combobox")).toBe(false);
    expect(isSensitiveSubmit("textbox")).toBe(true);
  });
});

describe("blockedInputReason", () => {
  it("blocks secret fields", () => {
    expect(blockedInputReason({ type: "PASSWORD" })).toBeTruthy();
    expect(blockedInputReason({ autocomplete: "cc-number" })).toBeTruthy();
    expect(blockedInputReason({ autocomplete: "section-pay billing cc-csc" })).toBeTruthy();
    expect(blockedInputReason({ autocomplete: "one-time-code" })).toBeTruthy();
  });
  it("allows ordinary fields", () => {
    expect(blockedInputReason({ type: "text", autocomplete: "name" })).toBeNull();
    expect(blockedInputReason({})).toBeNull();
  });
});
