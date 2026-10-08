// reposit-keyring-client 1.0.0
//
// The shared keyring client of the Reposit keyring standard (keyring/STANDARD.md in
// the staff-agent-toolkit repository). One file, Node 22, nothing but what Node ships with.
//
// HOW A TOOL TAKES IT: copy this file, byte for byte, into the tool's repository. Never edit
// a copy: a fix is made in staff-agent-toolkit, the version line above goes up, and each tool
// copies the new file (its release check compares the bytes; see STANDARD.md, "The shared client").
//
// What it does: keeps ONE long-lived secret per tool and account in the system keyring.
//   Linux: the Secret Service, spoken directly over the session bus (no secret-tool needed).
//   macOS: the built-in /usr/bin/security command. UNTESTED ON A REAL MAC (see STANDARD.md).
// What it never does: put a secret in an argument list or the environment, write a secret
// anywhere but the keyring, print or log anything, ask for a password window unless the caller
// says a person is signing in right now, or wait longer than its time limit.

import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";

export const VERSION = "1.0.0";

const LIMIT_MS = 3000; // every keyring call in an everyday command
const MAX_LIMIT_MS = 10000;
const PROMPT_MS = 120000; // only at sign-in, while a person answers a password window
const MAX_MESSAGE = 1 << 20; // one bus message
const MAX_RECEIVED = 4 << 20; // everything one connection may send us
const MAX_DEPTH = 16; // nesting inside one value
const MAX_ITEMS = 8; // items with our attributes that we will look at
const MAX_SECRET = 1600; // so the macOS command line stays under its 4096-character cut
const SECURITY = "/usr/bin/security"; // by full path: a `security` earlier on the PATH is never run

// Why a call stopped. `state` is one of the standard's states; `reason` is a short text made
// here, never text taken from the keyring service (which is untrusted input).
class Stop extends Error {
  constructor(state, reason) {
    super(reason);
    this.state = state;
    this.reason = reason;
  }
}
const bad = (why) => new Stop("failed", `the password store sent something unexpected: ${why}`);

// ---------------------------------------------------------------------------------------
// What a tool may pass in. All of it can end up in a bus message or a macOS command line,
// so the shapes are narrow on purpose.

const SERVICE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ACCOUNT = /^[a-z0-9@._+:/-]{1,200}$/;
const LABEL = /^[ !#-[\]-~]{1,160}$/; // printable ASCII without " and \
const SECRET = /^[\x20-\x7e]+$/;

function item(options) {
  const service = String(options.service ?? "");
  const account = String(options.account ?? "").toLowerCase();
  if (!SERVICE.test(service)) throw new TypeError("keyring: service must be the tool's command name");
  if (!ACCOUNT.test(account)) throw new TypeError("keyring: account has characters the standard does not allow");
  return { service, account, attributes: [["service", service], ["account", account], ["kind", "sign-in"]] };
}

function checkSecret(secret) {
  // The message never says what the value was.
  if (typeof secret !== "string" || secret.length > MAX_SECRET || !SECRET.test(secret)) {
    throw new TypeError(`keyring: the secret must be one line of printable ASCII, at most ${MAX_SECRET} characters`);
  }
}

function limitOf(options) {
  const asked = Number(options.limitMs);
  return Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_LIMIT_MS) : LIMIT_MS;
}

/** The fingerprint the settings folder keeps. Only for long random tokens, never a password a person chose. */
export function fingerprint(service, account, secret) {
  const it = item({ service, account });
  return "v1:" + createHash("sha256").update(`reposit-keyring-fingerprint-v1\n${it.service}\n${it.account}\n${secret}`).digest("hex");
}

function sameFingerprint(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------------------
// The bus wire format (D-Bus specification, "Marshaling"). Only what the Secret Service uses.
// Every value is aligned to its own size, counted from the start of the MESSAGE, which is why
// a header and its body are written into one buffer.

const ALIGN = { y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, s: 4, o: 4, g: 1, a: 4, "(": 8, "{": 8, v: 1, h: 4 };
const FIXED = { y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, h: 4 };
const OBJECT_PATH = /^(\/|(\/[A-Za-z0-9_]+)+)$/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }); // a byte-order mark stays in the text, and is then refused

// The index just past the single complete type that starts at sig[i].
function typeEnd(sig, i, depth = 0) {
  if (depth > MAX_DEPTH) throw bad("a type nested too deeply");
  const c = sig[i];
  if (c === "a") return typeEnd(sig, i + 1, depth + 1);
  if (c === "(" || c === "{") {
    const close = c === "(" ? ")" : "}";
    let j = i + 1;
    while (sig[j] !== close) {
      if (j >= sig.length) throw bad("a type that does not close");
      j = typeEnd(sig, j, depth + 1);
    }
    if (j === i + 1) throw bad("an empty structure");
    return j + 1;
  }
  if (c && Object.hasOwn(ALIGN, c)) return i + 1;
  throw bad("a type this client does not know");
}

function pad(out, to) {
  while (out.length % to) out.push(0);
}
function putU32(out, n) {
  out.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
}

// Appends one value of the type at sig[i] to `out` (an array of bytes). Returns the index after the type.
function put(out, sig, value, i = 0) {
  const c = sig[i];
  pad(out, ALIGN[c]);
  if (c === "y") out.push(value & 255);
  else if (c === "b") putU32(out, value ? 1 : 0);
  else if (c === "u") putU32(out, value);
  else if (c === "s" || c === "o" || c === "g") {
    const bytes = Buffer.from(String(value), "utf8");
    if (bytes.includes(0) || (c === "o" && !OBJECT_PATH.test(value))) throw bad("a name that cannot be sent");
    if (c === "g") out.push(bytes.length);
    else putU32(out, bytes.length);
    for (const byte of bytes) out.push(byte);
    out.push(0);
  } else if (c === "a") {
    const lengthAt = out.length;
    putU32(out, 0);
    pad(out, ALIGN[sig[i + 1]]); // this padding is NOT counted in the array's length
    const start = out.length;
    for (const element of value) put(out, sig, element, i + 1);
    const length = out.length - start;
    for (let k = 0; k < 4; k += 1) out[lengthAt + k] = (length >>> (8 * k)) & 255;
    return typeEnd(sig, i);
  } else if (c === "(" || c === "{") {
    let j = i + 1;
    let k = 0;
    while (sig[j] !== ")" && sig[j] !== "}") j = put(out, sig, value[k++], j);
    return j + 1;
  } else if (c === "v") {
    put(out, "g", value.sig);
    put(out, value.sig, value.value);
  } else throw new TypeError(`keyring: cannot write type ${c}`);
  return i + 1;
}

function marshal(sig, values, out = []) {
  for (let i = 0, k = 0; i < sig.length; k += 1) i = put(out, sig, values[k], i);
  return out;
}

// Reading is where a broken or hostile service is met, so every step checks that the bytes
// it is about to use are really there, and nothing loops without moving forward.
function need(r, n) {
  if (n < 0 || r.pos + n > r.end) throw bad("a message shorter than it claims");
}
function align(r, to) {
  r.pos += (to - (r.pos % to)) % to;
  need(r, 0);
}
function getU32(r) {
  align(r, 4);
  need(r, 4);
  const n = r.le ? r.buf.readUInt32LE(r.pos) : r.buf.readUInt32BE(r.pos);
  r.pos += 4;
  return n;
}

// Reads one value of the type at sig[i]. Returns [value, index after the type].
function get(r, sig, i = 0, depth = 0) {
  if (depth > MAX_DEPTH) throw bad("a value nested too deeply");
  const c = sig[i];
  if (c === "u" || c === "b" || c === "i" || c === "h") return [getU32(r), i + 1];
  if (Object.hasOwn(FIXED, c)) {
    align(r, FIXED[c]);
    need(r, FIXED[c]);
    const at = r.pos;
    r.pos += FIXED[c];
    return [c === "y" ? r.buf[at] : null, i + 1]; // wider numbers are stepped over; nothing here uses them
  }
  if (c === "s" || c === "o" || c === "g") {
    let length;
    if (c === "g") {
      need(r, 1);
      length = r.buf[r.pos++];
    } else length = getU32(r);
    need(r, length + 1);
    if (r.buf[r.pos + length] !== 0) throw bad("text without its end mark");
    let text;
    try {
      text = utf8.decode(r.buf.subarray(r.pos, r.pos + length));
    } catch {
      throw bad("text that is not UTF-8");
    }
    r.pos += length + 1;
    if (c === "o" && (!OBJECT_PATH.test(text) || length > 512)) throw bad("an object path that is not one");
    return [text, i + 1];
  }
  if (c === "a") {
    const after = typeEnd(sig, i);
    const length = getU32(r);
    if (length > MAX_MESSAGE) throw bad("a list longer than a message can be");
    align(r, ALIGN[sig[i + 1]]);
    need(r, length);
    const stop = r.pos + length;
    if (sig[i + 1] === "y") {
      const bytes = Buffer.from(r.buf.subarray(r.pos, stop));
      r.pos = stop;
      return [bytes, after];
    }
    const list = [];
    const inner = { buf: r.buf, pos: r.pos, end: stop, le: r.le };
    while (inner.pos < stop) {
      const before = inner.pos;
      list.push(get(inner, sig, i + 1, depth + 1)[0]);
      if (inner.pos <= before) throw bad("a list that does not advance");
    }
    r.pos = stop;
    return [list, after];
  }
  if (c === "(" || c === "{") {
    align(r, 8);
    const fields = [];
    let j = i + 1;
    while (sig[j] !== ")" && sig[j] !== "}") {
      const [value, next] = get(r, sig, j, depth + 1);
      fields.push(value);
      j = next;
    }
    return [fields, j + 1];
  }
  if (c === "v") {
    const [inner] = get(r, "g", 0, depth);
    if (!inner || typeEnd(inner, 0) !== inner.length) throw bad("a variant that is not one value");
    return [{ sig: inner, value: get(r, inner, 0, depth + 1)[0] }, i + 1];
  }
  throw bad("a type this client does not know");
}

function unmarshal(buf, sig, le = true, pos = 0) {
  const r = { buf, pos, end: buf.length, le };
  const values = [];
  for (let i = 0; i < sig.length; ) {
    typeEnd(sig, i);
    const [value, next] = get(r, sig, i);
    values.push(value);
    i = next;
  }
  return values;
}

const CALL = 1;
const RETURN = 2;
const ERROR = 3;
const SIGNAL = 4;
// Header fields (D-Bus specification, "Header Fields"): code, and the type its value must have.
const FIELD = { path: [1, "o"], iface: [2, "s"], member: [3, "s"], errorName: [4, "s"], replySerial: [5, "u"], destination: [6, "s"], sender: [7, "s"], signature: [8, "g"] };

function buildMessage(type, serial, fields, sig = "", args = []) {
  const header = [];
  for (const [name, [code, kind]] of Object.entries(FIELD)) {
    const value = name === "signature" ? sig : fields[name];
    if (value !== undefined && value !== "") header.push([code, { sig: kind, value }]);
  }
  const body = marshal(sig, args);
  // 108 is "l": little-endian. Then the type, no flags, protocol version 1, body length, serial.
  const out = marshal("yyyyuua(yv)", [108, type, 0, 1, body.length, serial, header]);
  pad(out, 8);
  return Buffer.concat([Buffer.from(out), Buffer.from(body)]);
}

// One whole message from the front of `buf`, or null when more bytes are needed.
function parseMessage(buf) {
  if (buf.length < 16) return null;
  const le = buf[0] === 108;
  if (!le && buf[0] !== 66) throw bad("a message with no byte order");
  if (buf[3] !== 1) throw bad("a protocol version this client does not speak");
  const bodyLength = le ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  const fieldsLength = le ? buf.readUInt32LE(12) : buf.readUInt32BE(12);
  const headerLength = 16 + fieldsLength + ((8 - (fieldsLength % 8)) % 8);
  const size = headerLength + bodyLength;
  if (fieldsLength > MAX_MESSAGE || bodyLength > MAX_MESSAGE || size > MAX_MESSAGE) throw bad("a message that is too large");
  if (buf.length < size) return null;
  const message = { size, le, type: buf[1], serial: le ? buf.readUInt32LE(8) : buf.readUInt32BE(8), signature: "", body: buf.subarray(headerLength, size) };
  const [fields] = unmarshal(buf.subarray(0, 16 + fieldsLength), "a(yv)", le, 12);
  for (const [code, variant] of fields) {
    for (const [name, [wanted, kind]] of Object.entries(FIELD)) {
      if (code === wanted && variant.sig === kind) message[name] = variant.value;
    }
  }
  return message;
}

// ---------------------------------------------------------------------------------------
// The session bus connection. One call at a time, one deadline for the whole connection.

// Where the session bus listens, from the environment alone. This client never starts a bus
// (libdbus "autolaunch" would), so no bus means no bus.
function busPath(env) {
  const unescape = (text) => {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  };
  for (const entry of String(env.DBUS_SESSION_BUS_ADDRESS ?? "").split(";")) {
    if (!entry.startsWith("unix:")) continue;
    const keys = Object.fromEntries(entry.slice(5).split(",").map((pair) => pair.split("=")).filter((pair) => pair.length === 2));
    if (keys.path) return unescape(keys.path);
    if (keys.abstract) return `\0${unescape(keys.abstract)}`;
    if (keys.runtime === "yes" && env.XDG_RUNTIME_DIR) return `${env.XDG_RUNTIME_DIR}/bus`;
  }
  if (env.DBUS_SESSION_BUS_ADDRESS) throw new Stop("no-bus", "the session bus address is not a local socket");
  if (env.XDG_RUNTIME_DIR) return `${env.XDG_RUNTIME_DIR}/bus`; // where systemd puts the user bus
  throw new Stop("no-bus", "this session has no session bus");
}

class Bus {
  constructor(socket, limitMs) {
    this.socket = socket;
    this.inbox = Buffer.alloc(0);
    this.received = 0;
    this.serial = 0;
    this.waiter = null;
    this.signals = [];
    this.expect = null;
    this.dead = null;
    this.setLimit(limitMs);
    socket.on("data", (chunk) => {
      this.received += chunk.length;
      if (this.received > MAX_RECEIVED) return this.fail(bad("more than this client will read"));
      this.inbox = Buffer.concat([this.inbox, chunk]);
      this.pump();
    });
    socket.on("error", () => this.fail(new Stop("failed", "the connection to the session bus broke")));
    socket.on("close", () => this.fail(new Stop("failed", "the session bus closed the connection")));
  }

  // The hard time limit. When it passes, whatever is waiting stops and the socket is gone.
  setLimit(ms) {
    clearTimeout(this.timer);
    if (this.dead) return;
    this.timer = setTimeout(() => this.fail(new Stop("failed", "the password store did not answer in time")), ms);
  }

  fail(error) {
    if (this.dead) return;
    this.dead = error;
    clearTimeout(this.timer);
    this.socket.destroy();
    this.waiter?.reject(error);
    this.waiter = null;
  }

  close() {
    this.fail(new Stop("failed", "closed"));
  }

  pump() {
    if (!this.waiter) return;
    try {
      const got = this.waiter.take();
      if (got === undefined) return;
      const { resolve } = this.waiter;
      this.waiter = null;
      resolve(got);
    } catch (error) {
      this.fail(error instanceof Stop ? error : bad("an answer that could not be read"));
    }
  }

  // Waits until take() returns something other than undefined. take() consumes from the inbox.
  wait(take) {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      this.waiter = { take, resolve, reject };
      this.pump();
    });
  }

  // The next whole message, or undefined. Only a signal from the one object somebody said they
  // will wait on (`this.expect`) is kept; every other signal is read and dropped.
  next() {
    const message = parseMessage(this.inbox);
    if (!message) return undefined;
    this.inbox = this.inbox.subarray(message.size);
    if (message.type === SIGNAL && this.expect && message.path === this.expect && this.signals.length < 16) this.signals.push(message);
    return message;
  }

  // Sign in to the bus as this user (D-Bus specification, "Authentication Protocol": EXTERNAL
  // means "believe the socket's own record of who I am"), then say hello.
  async start() {
    const uid = Buffer.from(String(process.getuid())).toString("hex");
    this.socket.write(`\0AUTH EXTERNAL ${uid}\r\n`);
    const line = await this.wait(() => {
      const end = this.inbox.indexOf("\r\n");
      if (end < 0) {
        if (this.inbox.length > 512) throw bad("no answer to the bus sign-in");
        return undefined;
      }
      const text = this.inbox.subarray(0, end).toString("latin1");
      this.inbox = this.inbox.subarray(end + 2);
      return text;
    });
    if (!line.startsWith("OK ")) throw new Stop("failed", "the session bus refused this user");
    this.socket.write("BEGIN\r\n");
    await this.call(DBUS, "/org/freedesktop/DBus", DBUS, "Hello", "", [], "s");
  }

  // A method call. Returns the reply's values, read as `reply` (the signature we expect: a
  // reply of any other shape is refused). An error reply throws a Stop made from its NAME only.
  async call(destination, path, iface, member, sig, args, reply) {
    if (this.dead) throw this.dead;
    const serial = ++this.serial;
    this.socket.write(buildMessage(CALL, serial, { path, iface, member, destination }, sig, args));
    const message = await this.wait(() => {
      for (let m = this.next(); m; m = this.next()) {
        if ((m.type === RETURN || m.type === ERROR) && m.replySerial === serial) return m;
      }
      return undefined;
    });
    if (message.type === ERROR) throw fromBusError(message.errorName);
    if (message.signature !== reply) throw bad("an answer of the wrong shape");
    return unmarshal(message.body, reply, message.le);
  }

  // Waits for one signal from one object.
  signal(path, iface, member, sig) {
    const take = () => {
      for (;;) {
        const at = this.signals.findIndex((m) => m.path === path && m.iface === iface && m.member === member && m.signature === sig);
        if (at >= 0) return ((m) => unmarshal(m.body, sig, m.le))(this.signals.splice(at, 1)[0]);
        if (!this.next()) return undefined;
      }
    };
    return this.wait(take);
  }
}

const DBUS = "org.freedesktop.DBus";

// What an error reply means. Only its name is used, and only against this list.
function fromBusError(name) {
  const known = String(name ?? "");
  if (known === "org.freedesktop.Secret.Error.IsLocked") return new Stop("locked", "the password store is locked");
  if (known === "org.freedesktop.Secret.Error.NoSuchObject" || known === `${DBUS}.Error.UnknownObject`) return new Stop("gone", "it is not there");
  if (known === `${DBUS}.Error.ServiceUnknown` || known === `${DBUS}.Error.NameHasNoOwner` || known.startsWith(`${DBUS}.Error.Spawn.`)) {
    return new Stop("no-keyring", "no password store is running in this session");
  }
  if (known === `${DBUS}.Error.AccessDenied`) return new Stop("blocked", "this session is not allowed to ask the password store");
  if (known === `${DBUS}.Error.NoReply` || known === `${DBUS}.Error.Timeout` || known === `${DBUS}.Error.TimedOut`) {
    return new Stop("failed", "the password store did not answer in time");
  }
  return new Stop("failed", "the password store answered with an error"); // its name is the store's text: not repeated
}

async function openBus(env, limitMs) {
  const path = busPath(env);
  let socket;
  try {
    socket = connect({ path });
  } catch {
    throw new Stop("no-bus", "the session bus cannot be reached");
  }
  const bus = new Bus(socket, limitMs);
  try {
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      // Creating or connecting a socket is what an agent sandbox refuses (EPERM, measured with
      // Anthropic's sandbox runtime). Anything else is a bus that is not there.
      socket.once("error", (error) => {
        const refused = error.code === "EPERM" || error.code === "EACCES";
        reject(new Stop(refused ? "blocked" : "no-bus", refused ? `connecting to the session bus is not permitted here (${error.code})` : "the session bus cannot be reached"));
      });
      socket.once("close", () => reject(bus.dead ?? new Stop("no-bus", "the session bus cannot be reached")));
    });
    await bus.start();
  } catch (error) {
    bus.close();
    throw error;
  }
  return bus;
}

// ---------------------------------------------------------------------------------------
// The Secret Service (freedesktop.org "Secret Service API"), as GNOME Keyring, KWallet and
// KeePassXC provide it. Subtle points:
//  - A "plain" session: the secret crosses the bus socket as it is. The other choice only
//    guards against a program already running as this user, which can ask the service itself.
//  - This client never calls Unlock or Prompt in an everyday command. Those are the only two
//    calls that can put a password window on screen; `interactive` (sign-in only) allows them.
//  - A reply's text (error messages, labels) is never shown to anyone.

const SECRETS = "org.freedesktop.secrets";
const ROOT = "/org/freedesktop/secrets";
const SERVICE_IF = "org.freedesktop.Secret.Service";
const PROMPT_IF = "org.freedesktop.Secret.Prompt";
const PROPS_IF = "org.freedesktop.DBus.Properties";

async function openSession(bus) {
  const [, session] = await bus.call(SECRETS, ROOT, SERVICE_IF, "OpenSession", "sv", ["plain", { sig: "s", value: "" }], "vo");
  return session;
}

// The default collection (the "login" keyring on GNOME), and whether it is locked.
async function defaultCollection(bus) {
  const [path] = await bus.call(SECRETS, ROOT, SERVICE_IF, "ReadAlias", "s", ["default"], "o");
  if (path === "/") return { path: null, locked: false };
  try {
    const [locked] = await bus.call(SECRETS, path, PROPS_IF, "Get", "ss", ["org.freedesktop.Secret.Collection", "Locked"], "v");
    if (locked.sig !== "b") throw bad("a lock state that is not yes or no");
    return { path, locked: locked.value !== 0 };
  } catch (error) {
    if (error.state === "gone") return { path: null, locked: false }; // an alias that points at nothing
    throw error;
  }
}

async function findItems(bus, attributes) {
  const [unlocked, locked] = await bus.call(SECRETS, ROOT, SERVICE_IF, "SearchItems", "a{ss}", [attributes], "aoao");
  return { unlocked: unlocked.slice(0, MAX_ITEMS), locked };
}

async function busLookup(bus, attributes) {
  const session = await openSession(bus);
  const { unlocked, locked } = await findItems(bus, attributes);
  if (unlocked.length) {
    const [found] = await bus.call(SECRETS, ROOT, SERVICE_IF, "GetSecrets", "aoo", [unlocked, session], "a{o(oayays)}");
    const secrets = found.map(([, [, , value]]) => value.toString("utf8"));
    if (secrets.length) return { state: "found", secrets };
    return { state: "failed", reason: "the password store listed a sign-in and would not give it" };
  }
  if (locked.length) return { state: "locked", reason: "the password store is locked" };
  // Nothing matched. A provider that cannot search while locked (KWallet, KeePassXC) says
  // "nothing" for a locked store, so "locked" is the honest answer whenever it is locked:
  // unlocking never loses anything, and being told to sign in again by mistake does.
  if ((await defaultCollection(bus)).locked) return { state: "locked", reason: "the password store is locked" };
  return { state: "missing", reason: "the password store has no such sign-in" };
}

// Unlocks one collection. Only ever reached with interactive: true.
async function unlock(bus, collection, promptMs, limitMs) {
  const [, prompt] = await bus.call(SECRETS, ROOT, SERVICE_IF, "Unlock", "ao", [[collection]], "aoo");
  if (prompt !== "/") {
    bus.expect = prompt;
    const rule = `type='signal',interface='${PROMPT_IF}',member='Completed',path='${prompt}'`;
    await bus.call(DBUS, "/org/freedesktop/DBus", DBUS, "AddMatch", "s", [rule], "");
    await bus.call(SECRETS, prompt, PROMPT_IF, "Prompt", "s", [""], "");
    // Only now is there a window a person may be reading, so only now is the limit longer.
    bus.setLimit(promptMs + limitMs);
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), promptMs);
    });
    let answer;
    try {
      answer = await Promise.race([bus.signal(prompt, PROMPT_IF, "Completed", "bv"), late]);
    } finally {
      clearTimeout(timer);
    }
    bus.setLimit(limitMs);
    if (!answer) {
      bus.waiter = null; // nobody answered: take the window away again
      await bus.call(SECRETS, prompt, PROMPT_IF, "Dismiss", "", [], "").catch(() => undefined);
    }
  }
  return !(await defaultCollection(bus)).locked;
}

// Best effort: removes one item, and takes away any question the store wants to ask about it.
async function drop(bus, path) {
  try {
    const [prompt] = await bus.call(SECRETS, path, "org.freedesktop.Secret.Item", "Delete", "", [], "o");
    if (prompt === "/") return true;
    await bus.call(SECRETS, prompt, PROMPT_IF, "Dismiss", "", [], "");
  } catch (error) {
    return error.state === "gone"; // already removed by someone else is removed
  }
  return false;
}

async function busStore(bus, attributes, label, secret, interactive, promptMs, limitMs) {
  const session = await openSession(bus);
  let home = await defaultCollection(bus);
  if (!home.path) return { state: "no-keyring", reason: "the password store has no keyring to put a sign-in in" };
  if (home.locked && interactive && (await unlock(bus, home.path, promptMs, limitMs))) home = { ...home, locked: false };
  if (home.locked) return { state: "locked", reason: "the password store is locked" };
  const properties = [
    ["org.freedesktop.Secret.Item.Label", { sig: "s", value: label }],
    ["org.freedesktop.Secret.Item.Attributes", { sig: "a{ss}", value: attributes }],
  ];
  // The secret: (session, parameters: none for a plain session, the value, its content type).
  const value = [session, Buffer.alloc(0), Buffer.from(secret, "utf8"), "text/plain; charset=utf8"];
  const [made, prompt] = await bus.call(SECRETS, home.path, "org.freedesktop.Secret.Collection", "CreateItem", "a{sv}(oayays)b", [properties, value, true], "oo");
  if (prompt !== "/") {
    await bus.call(SECRETS, prompt, PROMPT_IF, "Dismiss", "", [], "").catch(() => undefined);
    return { state: "locked", reason: "the password store wanted to ask a question before saving" };
  }
  // The proof is reading the new item back, by its own path. A save that cannot be proven is
  // undone, so that a sign-in which then goes to the file is in one place only.
  let proven = false;
  try {
    const [back] = await bus.call(SECRETS, ROOT, SERVICE_IF, "GetSecrets", "aoo", [[made], session], "a{o(oayays)}");
    proven = back.length === 1 && back[0][1][2].equals(value[2]);
  } finally {
    if (!proven) await drop(bus, made);
  }
  if (!proven) return { state: "failed", reason: "the password store did not give back what was saved" };
  // One item per tool and account: anything else carrying our attributes goes.
  const { unlocked } = await findItems(bus, attributes);
  for (const other of unlocked) {
    if (other !== made) await drop(bus, other);
  }
  return { state: "stored" };
}

async function busRemove(bus, attributes) {
  let removed = 0;
  // A few rounds, because one search is only looked at eight items deep.
  for (let round = 0; round < 8; round += 1) {
    const { unlocked, locked } = await findItems(bus, attributes);
    if (locked.length) return { state: "locked", reason: "the password store is locked" };
    if (!unlocked.length) {
      if (removed) return { state: "removed" };
      // As in busLookup: a locked store that lists nothing is locked, not empty.
      if ((await defaultCollection(bus)).locked) return { state: "locked", reason: "the password store is locked" };
      return { state: "missing", reason: "the password store has no such sign-in" };
    }
    for (const path of unlocked) {
      if (!(await drop(bus, path))) return { state: "locked", reason: "the password store would not remove the sign-in without asking" };
      removed += 1;
    }
  }
  return { state: "failed", reason: "the password store kept listing the sign-in after removing it" };
}

const PROVIDERS = { "gnome-keyring-d": "GNOME Keyring", "gnome-keyring-daemon": "GNOME Keyring", kwalletd5: "KDE Wallet", kwalletd6: "KDE Wallet", ksecretd: "KDE Wallet", keepassxc: "KeePassXC" };

// Which program answers, for `doctor`. Best effort: the name comes from /proc and is only
// shown when it is one this client knows.
async function provider(bus) {
  try {
    const [pid] = await bus.call(DBUS, "/org/freedesktop/DBus", DBUS, "GetConnectionUnixProcessID", "s", [SECRETS], "u");
    return PROVIDERS[readFileSync(`/proc/${pid}/comm`, "utf8").trim()] ?? "a password store";
  } catch {
    return "a password store";
  }
}

async function busProbe(bus) {
  await openSession(bus);
  const home = await defaultCollection(bus);
  const name = await provider(bus);
  if (!home.path) return { state: "no-keyring", reason: "the password store has no keyring to put a sign-in in", provider: name };
  return home.locked ? { state: "locked", reason: "the password store is locked", provider: name } : { state: "usable", provider: name };
}

async function onBus(options, work) {
  let bus;
  try {
    bus = await openBus(options.env ?? process.env, limitOf(options));
    return await work(bus);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    return { state: error.state === "gone" ? "failed" : error.state, reason: error.reason };
  } finally {
    bus?.close();
  }
}

// ---------------------------------------------------------------------------------------
// macOS: the built-in `security` command. WRITTEN FROM DOCUMENTATION AND NEVER RUN ON A MAC.
// Everything uncertain ends in "failed", and sign-in then keeps the file and says so.
//  - The secret is never an argument. To save, the whole add-generic-password command goes
//    down the standard input of `security -i`, with the secret as hex (-X), so that neither
//    the process list nor a shell ever sees it. The command line is cut at 4096 characters
//    and understands quotes and backslashes, hence the narrow shapes at the top of this file.
//  - The exit status is the low byte of Apple's error number: 44 not found (-25300),
//    36 interaction not allowed (-25308), 51 authorisation failed (-25293).
//  - `security` cannot be told never to show a window. The time limit bounds the wait; whether
//    a locked keychain shows a window to an agent-run read is one of the things a Mac must prove.

function runSecurity(options, args, input, limitMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(options.securityPath ?? SECURITY, args, { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve({ error: "ENOENT" });
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(result);
    };
    const timer = setTimeout(() => finish({ late: true }), limitMs);
    child.on("error", (error) => finish({ error: error.code ?? "ERROR" }));
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_MESSAGE) finish({ status: -1 });
      else chunks.push(chunk);
    });
    child.on("close", (status) => finish({ status, out: Buffer.concat(chunks).toString("utf8") }));
    child.stdin.end(input);
  });
}

function macStop(result) {
  if (result.late) return { state: "failed", reason: "the Mac keychain did not answer in time (it may be waiting for a password window)" };
  if (result.error === "ENOENT") return { state: "no-keyring", reason: "the Mac keychain command is missing" };
  if (result.error) return { state: result.error === "EPERM" || result.error === "EACCES" ? "blocked" : "failed", reason: `the Mac keychain command could not be run (${String(result.error).slice(0, 20)})` };
  if (result.status === 44) return { state: "missing", reason: "the Mac keychain has no such sign-in" };
  if (result.status === 36 || result.status === 51) return { state: "locked", reason: "the Mac keychain is locked or refused" };
  return { state: "failed", reason: `the Mac keychain command failed (status ${Number.isInteger(result.status) ? result.status : "unknown"})` };
}

async function macLookup(options, it) {
  const result = await runSecurity(options, ["find-generic-password", "-s", it.service, "-a", it.account, "-w"], "", limitOf(options));
  if (result.status !== 0) return macStop(result);
  return { state: "found", secrets: [result.out.replace(/\r?\n$/, "")] };
}

async function macStore(options, it, label, secret, interactive) {
  const hex = Buffer.from(secret, "utf8").toString("hex");
  const line = `add-generic-password -U -s ${it.service} -a ${it.account} -l "${label}" -j "Removing this signs the tool out." -X ${hex}\n`;
  if (line.length > 4000) return { state: "failed", reason: "the sign-in is too long for the Mac keychain command" };
  const result = await runSecurity(options, ["-i"], line, interactive ? (options.promptMs ?? PROMPT_MS) : limitOf(options));
  if (result.late || result.error) return macStop(result);
  // `security -i` does not report a failed command reliably, so the proof is reading it back.
  // An item holding something else was not written by this save (-U replaces in place), so it
  // is an earlier sign-in and is left alone.
  const back = await macLookup(options, it);
  if (back.state === "found" && back.secrets[0] === secret) return { state: "stored" };
  return back.state === "found" || back.state === "missing" ? { state: "failed", reason: "the Mac keychain did not give back what was saved" } : back;
}

async function macRemove(options, it) {
  const result = await runSecurity(options, ["delete-generic-password", "-s", it.service, "-a", it.account], "", limitOf(options));
  return result.status === 0 ? { state: "removed" } : macStop(result);
}

// ---------------------------------------------------------------------------------------
// The four calls. Each answers { state, reason?, ... } and never throws for anything the
// keyring does; a TypeError means the caller passed something the standard does not allow.
//
// states: found | stored | removed | usable | missing | locked | blocked | no-bus | no-keyring | failed
// options: service, account; env (default process.env); limitMs; and for tests only
//          platform and securityPath. No environment variable changes what this file does.

const platformOf = (options) => options.platform ?? process.platform;
const unsupported = { state: "no-keyring", reason: "this kind of computer has no password store these tools can use" };

/** Can a sign-in be kept in the keyring from here? Never prompts. */
export async function probe(options = {}) {
  if (platformOf(options) === "linux") return onBus(options, (bus) => busProbe(bus));
  if (platformOf(options) !== "darwin") return unsupported;
  return existsSync(options.securityPath ?? SECURITY) ? { state: "usable", provider: "the Mac keychain (untested)" } : macStop({ error: "ENOENT" });
}

/** Reads the secret. Never prompts, never waits past the limit. found: { secrets: [...] }, normally one. */
export async function lookup(options) {
  const it = item(options);
  if (platformOf(options) === "linux") return onBus(options, (bus) => busLookup(bus, it.attributes));
  return platformOf(options) === "darwin" ? macLookup(options, it) : unsupported;
}

/** Saves the secret, replacing any item with the same service and account. `interactive: true` only while a person is signing in. */
export async function store(options) {
  const it = item(options);
  checkSecret(options.secret);
  const label = String(options.label ?? "");
  if (!LABEL.test(label)) throw new TypeError("keyring: label must be plain printable text without quotes or backslashes");
  const interactive = options.interactive === true;
  if (platformOf(options) === "linux") return onBus(options, (bus) => busStore(bus, it.attributes, label, options.secret, interactive, options.promptMs ?? PROMPT_MS, limitOf(options)));
  return platformOf(options) === "darwin" ? macStore(options, it, label, options.secret, interactive) : unsupported;
}

/** Removes the item (sign-out, or after moving back to the file). Never prompts. */
export async function remove(options) {
  const it = item(options);
  if (platformOf(options) === "linux") return onBus(options, (bus) => busRemove(bus, it.attributes));
  return platformOf(options) === "darwin" ? macRemove(options, it) : unsupported;
}

// ---------------------------------------------------------------------------------------
// The standard's two decisions, so that every tool makes them the same way.

// [message, the fix, the fix in a tool that has no hourly pass and so no `renew` (an API token)].
const ERRORS = {
  KEYRING_LOCKED: ["Your sign-in is kept in this computer's password store, which is locked.", "Unlock it (log in to the desktop with your password, or open your password manager), then run this again."],
  KEYRING_BLOCKED: [
    "Your sign-in is kept in this computer's password store, which cannot be reached from inside this sandbox{pass}.",
    "Run `{renew}` (it runs outside the sandbox), then run this again.",
    "Run this command outside the sandbox, or a person signs in again with `{login} --store file`.",
  ],
  KEYRING_UNAVAILABLE: [
    "Your sign-in is kept in this computer's password store, and this session has none to ask ({reason}).",
    "In an agent sandbox, run `{renew}` outside it. Otherwise run this from your desktop session, or a person signs in again here with `{login} --store file`.",
    "Run this from your desktop session, outside any sandbox, or a person signs in again here with `{login} --store file`.",
  ],
  KEYRING_FAILED: ["This computer's password store did not answer properly ({reason}).", "Run `{renew}`. If it keeps happening, run `{doctor}`.", "Run this again. If it keeps happening, run `{doctor}`."],
  SIGN_IN_MISSING: ["The saved sign-in is not there any more.", "A person runs `{login}`."],
  SIGN_IN_MISMATCH: ["The sign-in that was found is not the one saved when you signed in, so it was not used and nothing was sent.", "A person runs `{login}`."],
  SIGN_IN_STORE_UNKNOWN: ["The settings say the sign-in is kept somewhere this version does not know.", "Update the tool, or a person runs `{login}`."],
};
const CODE_OF = { locked: "KEYRING_LOCKED", blocked: "KEYRING_BLOCKED", "no-bus": "KEYRING_UNAVAILABLE", "no-keyring": "KEYRING_UNAVAILABLE", failed: "KEYRING_FAILED", missing: "SIGN_IN_MISSING" };

/**
 * The standard's error for a code: { ok: false, code, message, help }. `tool` names the commands
 * to print: name, login, doctor, and renew (false for a tool with no hourly pass to renew).
 */
export function signInError(code, tool = {}, reason = "") {
  const [message, withRenew, withoutRenew] = ERRORS[code];
  const name = tool.name ?? "the tool";
  const renews = tool.renew !== false;
  const words = { reason, pass: renews ? ", and the hourly pass has run out" : "", renew: tool.renew ?? `${name} renew`, login: tool.login ?? `${name} auth login`, doctor: tool.doctor ?? `${name} doctor` };
  const fill = (text) => text.replace(/\{(\w+)\}/g, (_, key) => words[key]);
  return { ok: false, code, message: fill(message), help: fill(renews ? withRenew : (withoutRenew ?? withRenew)) };
}

const WHY_FILE = {
  chosen: "as chosen at sign-in",
  "no-bus": "because this session had no password store to ask",
  "no-keyring": "because no password store was available",
  locked: "because the password store was locked",
  blocked: "because the password store could not be reached from here",
  failed: "because the password store did not answer properly",
};

/** One plain sentence saying where a sign-in is kept: for sign-in itself, setup's summary, auth status and doctor. */
export function describeStore(saved) {
  if (saved.store === "keyring") return `Your sign-in is kept in this computer's password store${saved.provider ? ` (${saved.provider})` : ""}.`;
  return `Your sign-in is kept in a private file on this computer, ${WHY_FILE[saved.reason] ?? "as it was before the password store was used"}.`;
}

/**
 * At sign-in: where does this sign-in go? want: "auto" (keyring if usable, else the file, stated),
 * "keyring" (or refuse), "file". Answers { store, fingerprint, reason?, provider? } for the tool
 * to write into its settings folder, or { ok: false, ... } when "keyring" was asked and cannot be had.
 * The tool writes the secret into its file only when store is "file".
 */
export async function saveSignIn(options) {
  const it = item(options);
  checkSecret(options.secret);
  const print = fingerprint(it.service, it.account, options.secret);
  const want = options.want ?? "auto";
  if (want === "file") return { store: "file", fingerprint: print, reason: "chosen" };
  if (want !== "auto" && want !== "keyring") throw new TypeError("keyring: want must be auto, keyring or file");
  let result = await probe(options);
  const name = result.provider;
  // A locked store is still tried when a person is here: saving is what lets it ask to be unlocked.
  const tried = result.state === "usable" || (result.state === "locked" && options.interactive === true);
  if (tried) result = await store(options);
  if (result.state === "stored") return { store: "keyring", fingerprint: print, provider: name };
  // A save that began and could not be proven must not leave the secret behind in the store.
  // Only this secret is removed: an item the save never reached (an earlier sign-in, which
  // stays the sign-in when "keyring" was asked and nothing is recorded) is left as it was.
  if (tried && result.state === "failed") {
    const left = await lookup(options);
    if (left.state === "found" && left.secrets.includes(options.secret)) await remove(options);
  }
  if (want === "keyring") return { ...signInError(CODE_OF[result.state], options.tool, result.reason), state: result.state };
  return { store: "file", fingerprint: print, reason: result.state, detail: result.reason };
}

/**
 * On every later read: the secret from the store the settings folder recorded, and no other.
 * store: what the settings say ("keyring", "file", or nothing for a sign-in saved before the
 * standard); fingerprint: what the settings say; fileSecret: the secret from the tool's own
 * file when the store is the file. Answers { ok: true, secret } or { ok: false, code, message, help, state }.
 */
export async function loadSignIn(options) {
  const it = item(options);
  const stored = options.store ?? "file";
  const matches = (secret) => !options.fingerprint || sameFingerprint(options.fingerprint, fingerprint(it.service, it.account, secret));
  if (stored === "file") {
    if (typeof options.fileSecret !== "string" || !options.fileSecret) return { ...signInError("SIGN_IN_MISSING", options.tool), state: "missing" };
    return matches(options.fileSecret) ? { ok: true, secret: options.fileSecret } : { ...signInError("SIGN_IN_MISMATCH", options.tool), state: "mismatch" };
  }
  if (stored !== "keyring") return { ...signInError("SIGN_IN_STORE_UNKNOWN", options.tool), state: "failed" };
  // A keyring sign-in with no fingerprint is refused: the settings folder must say which secret it means.
  if (!options.fingerprint) return { ...signInError("SIGN_IN_MISMATCH", options.tool), state: "mismatch" };
  const result = await lookup(options);
  if (result.state !== "found") return { ...signInError(CODE_OF[result.state], options.tool, result.reason), state: result.state };
  const secret = result.secrets.find(matches);
  return secret === undefined ? { ...signInError("SIGN_IN_MISMATCH", options.tool), state: "mismatch" } : { ok: true, secret };
}

// For this file's own tests, and for nothing else.
export const _wire = { marshal, unmarshal, buildMessage, parseMessage, typeEnd, busPath, openBus, Stop };
