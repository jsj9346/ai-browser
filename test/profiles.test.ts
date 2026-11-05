import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isFuseEnabled } from "../src/main/fuses";
import { profilePartition, Profiles } from "../src/main/profiles";

describe("Profiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "neo-browser-profiles-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const partitionDir = (id: string) => join(dir, "Partitions", `profile-${id}`);

  it("keeps profiles and their hosts across restarts, in a file only the owner can read", () => {
    const profiles = new Profiles(dir);
    const profile = profiles.create("  업무  ")!;
    profiles.setHosts(profile.id, ["a.example"]);
    const reloaded = new Profiles(dir);
    reloaded.load();
    expect(reloaded.list()).toEqual([{ id: profile.id, name: "업무", hosts: ["a.example"] }]);
    expect(statSync(join(dir, "profiles.json")).mode & 0o077).toBe(0);
  });

  it("refuses an empty name", () => {
    expect(new Profiles(dir).create("   ")).toBeNull();
  });

  it("removes a deleted profile's files at the next start, not before", () => {
    const profiles = new Profiles(dir);
    const profile = profiles.create("업무")!;
    mkdirSync(partitionDir(profile.id), { recursive: true });
    profiles.markDeleted(profile.id);
    expect(profiles.list()).toEqual([]);
    expect(existsSync(partitionDir(profile.id))).toBe(true);
    const reloaded = new Profiles(dir);
    reloaded.load();
    expect(existsSync(partitionDir(profile.id))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "profiles.json"), "utf8")).deleted).toEqual([]);
  });

  it("does not follow a tampered deleted id out of its folder", () => {
    const outside = join(dir, "keep");
    mkdirSync(outside);
    writeFileSync(join(dir, "profiles.json"), JSON.stringify({ profiles: [], deleted: ["../../keep"] }));
    new Profiles(dir).load();
    expect(existsSync(outside)).toBe(true);
  });

  it("names the partition so Chromium persists it", () => {
    expect(profilePartition("x")).toBe("persist:profile-x");
  });
});

describe("isFuseEnabled", () => {
  const SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
  const binary = (wires: string) => Buffer.concat([Buffer.from("junk"), Buffer.from(SENTINEL), Buffer.from([1, wires.length]), Buffer.from(wires)]);

  it("reads the fuse at its index", () => {
    expect(isFuseEnabled(binary("110"), 1)).toBe(true);
    expect(isFuseEnabled(binary("101"), 1)).toBe(false);
  });

  it("treats a missing sentinel or fuse as off", () => {
    expect(isFuseEnabled(Buffer.from("no sentinel"), 1)).toBe(false);
    expect(isFuseEnabled(binary("1"), 1)).toBe(false);
  });
});
