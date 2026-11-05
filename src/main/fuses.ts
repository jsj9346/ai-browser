// Electron's fuses live in its binary, and `npm install` can restore the binary with cookie encryption off.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
const COOKIE_ENCRYPTION_FUSE = 1;
const ENABLED = 0x31;

/** Reads a fuse from the binary's wire: the sentinel, a version byte, a length byte, then one byte per fuse. */
export function isFuseEnabled(binary: Buffer, index: number): boolean {
  const start = binary.indexOf(SENTINEL);
  if (start < 0) return false;
  const lengthAt = start + SENTINEL.length + 1;
  const length = binary[lengthAt] ?? 0;
  return index < length && binary[lengthAt + 1 + index] === ENABLED;
}

function electronBinary(): string {
  return process.platform === "darwin"
    ? join(dirname(process.execPath), "../Frameworks/Electron Framework.framework/Electron Framework")
    : process.execPath;
}

let cached: boolean | null = null;

/** False when the binary cannot be read, so a saved profile is never created without encrypted cookies. */
export function cookieEncryptionEnabled(): boolean {
  if (cached === null) {
    try {
      cached = isFuseEnabled(readFileSync(electronBinary()), COOKIE_ENCRYPTION_FUSE);
    } catch {
      cached = false;
    }
  }
  return cached;
}
