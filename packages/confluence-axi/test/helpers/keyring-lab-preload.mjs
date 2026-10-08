// Loaded (node --import) into every copy of the tool that keyring-lab.test.ts starts.
//
// 1. It REFUSES to go on outside a keyring lab: a private bus, a throwaway home, no display.
//    The tool it guards is about to ask "this computer's password store", and outside a lab
//    that would be the desktop's real one.
// 2. Nothing leaves the machine: the one site the tool is let reach is the lab's made-up one
//    (a name under .invalid, which no resolver answers), and that goes to the test's stand-in
//    for Confluence on a loopback port instead. Atlassian is never asked anything.

import { existsSync } from "node:fs";

const env = process.env;
const lab = env.REPOSIT_KEYRING_LAB ?? "";
const inside = (value) => typeof value === "string" && value.startsWith(`${lab}/`);
const problems = [];
if (!lab.includes("/krlab-") || !existsSync(`${lab}/.reposit-keyring-lab`)) {
  problems.push("not a lab folder");
}
if (!inside(env.HOME)) problems.push("HOME is not the lab's");
if (!inside(env.XDG_RUNTIME_DIR)) problems.push("XDG_RUNTIME_DIR is not the lab's");
if (env.DBUS_SESSION_BUS_ADDRESS !== `unix:path=${lab}/run/bus`) {
  problems.push("the bus address is not the lab's");
}
for (const name of [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "GNOME_KEYRING_CONTROL",
  "SSH_AUTH_SOCK",
  "XDG_CONFIG_HOME",
  "ATLASSIAN_SITE",
  "ATLASSIAN_EMAIL",
  "ATLASSIAN_API_TOKEN",
]) {
  if (env[name]) problems.push(`${name} is set`);
}
const confluence = env.REPOSIT_KEYRING_LAB_CONFLUENCE ?? "";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(confluence)) problems.push("no stand-in for Confluence");
if (problems.length) {
  process.stderr.write(
    `keyring lab: refusing to run the tool outside a lab (${problems.join("; ")})\n`,
  );
  process.exit(97);
}

const SITE = "https://confluence.lab.invalid";
const send = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (url.origin === SITE) return send(`${confluence}${url.pathname}${url.search}`, init);
  return Promise.reject(new Error(`the keyring lab sends nothing to ${url.origin}`));
};
