// Types shared by the main process, the preload script and the panel.
import type { AgentEvent } from "../agent";
import type { LoginState } from "../egress";

export interface PanelSettings {
  model: string;
  hasKey: boolean;
  /** False when this system cannot encrypt the key, so it is kept only until the app quits. */
  keyPersisted: boolean;
}

export interface PanelProfiles {
  /** False without encrypted cookies and a keyring. New tasks then stay in memory. */
  available: boolean;
  items: { id: string; name: string }[];
  /** The current task's profile, or null for a temporary session. */
  current: string | null;
  /** Hosts this profile keeps allowed. */
  hosts: string[];
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
  /** Lets the task reach a host the guard blocked. Only the user can do this. */
  allowHost(host: string): Promise<void>;
  /** Resolves with an error message, or null once login has started. */
  startLogin(url: string): Promise<string | null>;
  reopenLogin(): Promise<void>;
  finishLogin(): Promise<void>;
  cancelLogin(): Promise<void>;
  chooseLoginHosts(hosts: string[]): Promise<void>;
  getProfiles(): Promise<PanelProfiles>;
  createProfile(name: string): Promise<PanelProfiles>;
  selectProfile(id: string | null): Promise<PanelProfiles>;
  deleteProfile(id: string): Promise<PanelProfiles>;
  removeProfileHost(host: string): Promise<PanelProfiles>;
  onLogin(listener: (state: LoginState | null) => void): void;
  onProfiles(listener: (profiles: PanelProfiles) => void): void;
  onAgentEvent(listener: (event: AgentEvent) => void): void;
  onConfirm(listener: (request: { id: number; message: string }) => void): void;
  onConfirmClosed(listener: (id: number) => void): void;
  onPageUrl(listener: (url: string) => void): void;
  onHostBlocked(listener: (host: string) => void): void;
}
