// Saved profiles: a login kept in a persistent partition, and the hosts the user allowed for it.
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Profile {
  id: string;
  name: string;
  hosts: string[];
}

const MAX_NAME_LENGTH = 40;
const VALID_ID = /^[0-9a-f-]{36}$/;
const partitionName = (id: string) => `profile-${id}`;

export const profilePartition = (id: string) => `persist:${partitionName(id)}`;

export class Profiles {
  private profiles: Profile[] = [];
  /** Chromium keeps a partition's files open, so they can only be removed before its session is opened. */
  private deleted: string[] = [];

  constructor(private readonly dataDir: string) {}

  private get file(): string {
    return join(this.dataDir, "profiles.json");
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify({ profiles: this.profiles, deleted: this.deleted }), { mode: 0o600 });
  }

  /** Call this before opening any profile's session. */
  load(): void {
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      this.profiles = saved.profiles ?? [];
      this.deleted = saved.deleted ?? [];
    } catch {
      return; // First run.
    }
    // An id that fails the check is dropped, because it could otherwise point outside the folder.
    const remaining = this.deleted.filter((id) => VALID_ID.test(id) && !this.removeFiles(id));
    if (remaining.length !== this.deleted.length) {
      this.deleted = remaining;
      this.save();
    }
  }

  private removeFiles(id: string): boolean {
    try {
      rmSync(join(this.dataDir, "Partitions", partitionName(id)), { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  list(): Profile[] {
    return this.profiles;
  }

  get(id: string): Profile | undefined {
    return this.profiles.find((profile) => profile.id === id);
  }

  /** Returns null when the name is empty. */
  create(rawName: string): Profile | null {
    const name = rawName.trim().slice(0, MAX_NAME_LENGTH);
    if (!name) return null;
    const profile: Profile = { id: randomUUID(), name, hosts: [] };
    this.profiles.push(profile);
    this.save();
    return profile;
  }

  setHosts(id: string, hosts: string[]): void {
    const profile = this.get(id);
    if (!profile) return;
    profile.hosts = hosts;
    this.save();
  }

  /** The files go at the next start. Clear the session's data first, so nothing readable waits until then. */
  markDeleted(id: string): void {
    if (!this.get(id)) return;
    this.profiles = this.profiles.filter((profile) => profile.id !== id);
    this.deleted.push(id);
    this.save();
  }
}
