// Saved profiles keep logins on disk, and Electron stores cookies in plain text unless this fuse is on.
// The app reads the fuse at run time and turns profiles off when it is off, so a skipped run fails safe.
import { flipFuses, FuseV1Options, FuseVersion } from "@electron/fuses";
import electronPath from "electron";

await flipFuses(electronPath, {
  version: FuseVersion.V1,
  [FuseV1Options.EnableCookieEncryption]: true,
  resetAdHocDarwinSignature: process.platform === "darwin",
});
console.log("Electron cookie encryption is on");
