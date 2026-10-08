import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeyringAccess } from "../src/config.js";
import { SEALED } from "./helpers/sealed.js";

// NEVER A REAL PASSWORD STORE. Pointing HOME somewhere else does not move it:
// the session bus address decides which one answers. So, before anything else
// runs (as keyring/test/safe.mjs does in Marl0nL/staff-agent-toolkit): no bus
// address, no display, and a runtime folder that is not there.
for (const name of [
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "GNOME_KEYRING_CONTROL",
]) {
  delete process.env[name];
}
process.env["XDG_RUNTIME_DIR"] = "/nonexistent/confluence-axi-tests";

// And whatever a test forgets: the shared client is told it is on Linux with
// NO session bus. It opens no socket and runs no program (so not a Mac's
// `security` either, on a Mac), and answers as a computer with no password
// store does. A test that wants one points it at a stand-in
// (test/helpers/passwordStore.ts).
setKeyringAccess(SEALED);

// Never the real settings folder: a test that forgets to set its own gets a
// throwaway one, not ~/.config/atlassian-axi with a person's sign-in in it.
const home = mkdtempSync(join(tmpdir(), "confluence-axi-test-"));
process.env["HOME"] = home;
process.env["XDG_CONFIG_HOME"] = join(home, "config");
for (const name of [
  "ATLASSIAN_SITE",
  "ATLASSIAN_EMAIL",
  "ATLASSIAN_API_TOKEN",
  "ATLASSIAN_AXI_OAUTH_CLIENT_ID",
  "ATLASSIAN_AXI_OAUTH_CLIENT_SECRET",
]) {
  delete process.env[name];
}
