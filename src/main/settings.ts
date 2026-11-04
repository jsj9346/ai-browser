// The API key stays in the main process. The panel only learns whether one exists.
import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PanelSettings } from "./ipc";

const MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);
const DEFAULT_MODEL = "claude-opus-5-5";

/** On Linux without a keyring, safeStorage falls back to a hardcoded password, which is not encryption. */
function canEncrypt(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform !== "linux") return true;
  const backend = safeStorage.getSelectedStorageBackend();
  return backend !== "basic_text" && backend !== "unknown";
}

export class Settings {
  private model = DEFAULT_MODEL;
  private key = "";

  private get file(): string {
    return join(app.getPath("userData"), "settings.json");
  }

  load(): void {
    let saved: { model?: string; encryptedKey?: string };
    try {
      saved = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return; // First run.
    }
    if (saved.model && MODELS.has(saved.model)) this.model = saved.model;
    if (saved.encryptedKey && canEncrypt()) {
      try {
        this.key = safeStorage.decryptString(Buffer.from(saved.encryptedKey, "base64"));
      } catch {
        // Encrypted on another system or keyring. The panel will ask for the key again.
      }
    }
  }

  save(input: { apiKey: string; model: string }): void {
    if (MODELS.has(input.model)) this.model = input.model;
    if (input.apiKey) this.key = input.apiKey;
    const encryptedKey = this.key && canEncrypt() ? safeStorage.encryptString(this.key).toString("base64") : undefined;
    writeFileSync(this.file, JSON.stringify({ model: this.model, encryptedKey }), { mode: 0o600 });
  }

  get apiKey(): string {
    return this.key;
  }

  get selectedModel(): string {
    return this.model;
  }

  forPanel(): PanelSettings {
    return { model: this.model, hasKey: this.key !== "", keyPersisted: canEncrypt() };
  }
}
