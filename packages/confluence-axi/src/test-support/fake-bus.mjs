// A stand-in session bus with a stand-in password store on it, for tests that must run
// anywhere (no keyring installed) and for the hostile cases no real keyring will play.
// It listens on a socket in a throwaway folder; nothing here touches a real bus.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _wire } from "../keyring.mjs";

const { buildMessage, parseMessage, unmarshal } = _wire;
const LOGIN = "/org/freedesktop/secrets/collection/login";
const PROMPT = "/org/freedesktop/secrets/prompt/p1";

/**
 * Starts the stand-in. `state` is live: tests change it between calls.
 *   items: [{ path, attributes: {..}, secret, locked }]
 *   locked: the default collection is locked;  searchWhenLocked: a locked store still lists items (GNOME does)
 *   alias: what ReadAlias answers ("/" for no default keyring)
 *   prompt: what answering the unlock window does: "unlock" | "dismiss" | "never"
 *   on: { Member: (ctx) => true } to take over one call (ctx.reply, ctx.error, ctx.raw; return true = handled)
 *   auth: the line answered to AUTH;  greeting: bytes sent instead of any conversation
 */
export async function startFakeBus(initial = {}) {
  const base = tmpdir().length <= 40 ? tmpdir() : "/tmp";
  const folder = mkdtempSync(join(base, "krfake-"));
  const state = { items: [], locked: false, searchWhenLocked: true, alias: LOGIN, prompt: "unlock", on: {}, auth: "OK 0123456789abcdef0123456789abcdef", ...initial };
  const calls = [];
  const sockets = new Set();
  let serial = 1000;
  let made = 0;

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let inbox = Buffer.alloc(0);
    let begun = false;
    if (state.greeting) socket.write(state.greeting);
    socket.on("data", (chunk) => {
      inbox = Buffer.concat([inbox, chunk]);
      while (!begun) {
        const end = inbox.indexOf("\r\n");
        if (end < 0) return;
        const line = inbox.subarray(0, end).toString("latin1").replace(/^\0/, "");
        inbox = inbox.subarray(end + 2);
        if (line.startsWith("AUTH")) socket.write(`${state.auth}\r\n`);
        if (line === "BEGIN") begun = true;
      }
      for (let m = parseMessage(inbox); m; m = parseMessage(inbox)) {
        inbox = inbox.subarray(m.size);
        handle(socket, m);
      }
    });
  });

  function handle(socket, m) {
    const args = unmarshal(m.body, m.signature, m.le);
    calls.push({ member: m.member, path: m.path, args });
    const ctx = {
      message: m,
      args,
      raw: (bytes) => socket.write(bytes),
      reply: (sig = "", values = []) => socket.write(buildMessage(2, ++serial, { replySerial: m.serial, sender: ":1.9" }, sig, values)),
      error: (name, text = "") => socket.write(buildMessage(3, ++serial, { replySerial: m.serial, errorName: name, sender: ":1.9" }, text ? "s" : "", text ? [text] : [])),
      signal: (path, iface, member, sig, values) => socket.write(buildMessage(4, ++serial, { path, iface, member, sender: ":1.9" }, sig, values)),
    };
    if (state.on[m.member]?.(ctx)) return;
    if (m.destination === "org.freedesktop.secrets" && state.absent) return ctx.error("org.freedesktop.DBus.Error.ServiceUnknown", "The name is not activatable");
    const matching = (wanted) => state.items.filter((it) => wanted.every(([key, value]) => it.attributes[key] === value));
    switch (m.member) {
      case "Hello":
        return ctx.reply("s", [":1.42"]);
      case "AddMatch":
        return ctx.reply();
      case "GetConnectionUnixProcessID":
        return ctx.reply("u", [process.pid]);
      case "OpenSession":
        return args[0] === "plain" ? ctx.reply("vo", [{ sig: "s", value: "" }, "/org/freedesktop/secrets/session/s1"]) : ctx.error("org.freedesktop.DBus.Error.NotSupported");
      case "ReadAlias":
        return ctx.reply("o", [state.alias]);
      case "Get":
        return m.path === LOGIN ? ctx.reply("v", [{ sig: "b", value: state.locked }]) : ctx.error("org.freedesktop.DBus.Error.UnknownObject");
      case "SearchItems": {
        const found = state.locked && !state.searchWhenLocked ? [] : matching(args[0]);
        const isLocked = (it) => it.locked || state.locked;
        return ctx.reply("aoao", [found.filter((it) => !isLocked(it)).map((it) => it.path), found.filter(isLocked).map((it) => it.path)]);
      }
      case "GetSecrets": {
        const rows = state.items.filter((it) => args[0].includes(it.path)).map((it) => [it.path, [args[1], Buffer.alloc(0), Buffer.from(it.secret), "text/plain"]]);
        return ctx.reply("a{o(oayays)}", [rows]);
      }
      case "CreateItem": {
        if (state.locked) return ctx.error("org.freedesktop.Secret.Error.IsLocked");
        const attributes = Object.fromEntries(args[0].find(([key]) => key.endsWith(".Attributes"))[1].value);
        const label = args[0].find(([key]) => key.endsWith(".Label"))[1].value;
        const same = state.items.find((it) => JSON.stringify(it.attributes) === JSON.stringify(attributes));
        const path = same?.path ?? `${LOGIN}/${++made}`;
        if (same) state.items.splice(state.items.indexOf(same), 1);
        state.items.push({ path, attributes, label, secret: args[1][2].toString("utf8"), locked: false });
        return ctx.reply("oo", [path, "/"]);
      }
      case "Delete":
        state.items = state.items.filter((it) => it.path !== m.path);
        return ctx.reply("o", ["/"]);
      case "Unlock":
        return state.locked ? ctx.reply("aoo", [[], PROMPT]) : ctx.reply("aoo", [args[0], "/"]);
      case "Prompt":
        ctx.reply();
        if (state.prompt === "unlock") state.locked = false;
        if (state.prompt !== "never") ctx.signal(PROMPT, "org.freedesktop.Secret.Prompt", "Completed", "bv", [state.prompt === "dismiss", { sig: "ao", value: [] }]);
        return undefined;
      case "Dismiss":
        return ctx.reply();
      default:
        return ctx.error("org.freedesktop.DBus.Error.UnknownMethod");
    }
  }

  await new Promise((resolve) => server.listen(join(folder, "bus"), resolve));
  return {
    state,
    calls,
    // The whole environment a call is given: only this bus, nothing of the real session.
    env: { DBUS_SESSION_BUS_ADDRESS: `unix:path=${folder}/bus,guid=0123456789abcdef0123456789abcdef` },
    path: join(folder, "bus"),
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      if (folder.includes("/krfake-")) rmSync(folder, { recursive: true, force: true });
    },
  };
}
