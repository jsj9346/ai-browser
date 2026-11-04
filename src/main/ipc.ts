// Types shared by the main process, the preload script and the panel.
import type { AgentEvent } from "../agent";

export interface PanelSettings {
  model: string;
  hasKey: boolean;
  /** False when this system cannot encrypt the key, so it is kept only until the app quits. */
  keyPersisted: boolean;
}

export interface Notice {
  level: "progress" | "error";
  text: string;
  needsKey?: boolean;
}

export interface PanelApi {
  getSettings(): Promise<PanelSettings>;
  saveSettings(input: { apiKey: string; model: string }): Promise<PanelSettings>;
  /** Resolves with an error message, or null when the page loaded. */
  navigate(url: string): Promise<string | null>;
  runTask(prompt: string): Promise<Notice | null>;
  stop(): Promise<void>;
  answerConfirm(id: number, answer: boolean): Promise<void>;
  onAgentEvent(listener: (event: AgentEvent) => void): void;
  onConfirm(listener: (request: { id: number; message: string }) => void): void;
  onConfirmClosed(listener: (id: number) => void): void;
  onPageUrl(listener: (url: string) => void): void;
}
