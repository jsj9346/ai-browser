// Safety rules enforced in code, independent of what the model decides.
// A web page can steer the model through prompt injection, but it cannot change these checks.

export function parseWebUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Login exposes credentials, so it only starts over https. A local dev server is the one exception. */
export function isLoginUrlAllowed(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
}

const SENSITIVE_EN =
  /\b(buy|purchase|pay|payment|checkout|order|delete|remove|erase|send|transfer|submit|confirm|publish|post|tweet|share|subscribe|unsubscribe|cancel|sign ?up|sign ?out|log ?out|install|authorize|grant|accept|withdraw|deposit)\b/i;
const SENSITIVE_KO =
  /결제|구매|구입|주문|삭제|제거|송금|이체|출금|입금|보내기|전송|발송|제출|게시|등록|공유|구독|해지|탈퇴|취소|가입|로그아웃|설치|승인|동의|확인/;

const SEARCH_ROLES = new Set(["searchbox", "combobox"]);
const LONG_LINK_NAME = 40; // Long link text is usually a headline, not an action label.

/** Whether clicking this element should need the user's approval. */
export function isSensitiveClick(role: string, name: string): boolean {
  if (role === "link" && name.length > LONG_LINK_NAME) return false;
  return SENSITIVE_EN.test(name) || SENSITIVE_KO.test(name);
}

/** Submitting a search box is routine. Any other form submission can have side effects. */
export function isSensitiveSubmit(role: string): boolean {
  return !SEARCH_ROLES.has(role);
}

const SECRET_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code)/;

/** Returns why the agent may never type into this field, or null if it may. */
export function blockedInputReason(attributes: Record<string, string>): string | null {
  if ((attributes.type ?? "").toLowerCase() === "password") return "password field";
  const autocomplete = (attributes.autocomplete ?? "").trim().toLowerCase();
  for (const token of autocomplete.split(/\s+/)) {
    if (SECRET_AUTOCOMPLETE.test(token)) return `sensitive field (autocomplete=${token})`;
  }
  return null;
}
