/**
 * Stand-ins for this computer's password store, for unit tests. No test may
 * reach a real one (test/setup.ts seals the client first).
 *
 * What is faked is the STORE, never the client: the shared client itself
 * (src/keyring.mjs, the bytes staff get) runs against
 *  - `startStore()`: the toolkit's stand-in session bus
 *    (src/test-support/fake-bus.mjs, a byte-for-byte copy of
 *    keyring/test/fake-bus.mjs in Marl0nL/staff-agent-toolkit), on a socket in
 *    a throwaway folder; and
 *  - `startMac()`: a stand-in for /usr/bin/security, as that repository's
 *    macos.test.mjs builds one. THIS IS NOT A TEST ON A MAC.
 * So every decision a test sees (which state, which code, what is recorded)
 * is the real client's, not a re-implementation of it.
 */
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeyringAccess, signInItem } from "../../src/config.js";
// @ts-expect-error a plain .mjs copy with no types of its own
import { startFakeBus } from "../../src/test-support/fake-bus.mjs";
import { SEALED } from "./sealed.js";

export interface StoreItem {
  path: string;
  attributes: Record<string, string>;
  label?: string;
  secret: string;
  locked?: boolean;
}

interface Ctx {
  reply(sig?: string, values?: unknown[]): void;
  error(name: string, text?: string): void;
}

export interface FakeStore {
  /** Live: a test changes it between commands. */
  state: {
    items: StoreItem[];
    locked: boolean;
    searchWhenLocked: boolean;
    alias: string;
    prompt: "unlock" | "dismiss" | "never";
    absent?: boolean;
    on: Record<string, (ctx: Ctx) => boolean | void>;
  };
  /** Every call the store was asked, in order. */
  calls: Array<{ member: string; path: string; args: unknown[] }>;
  /** The members asked since the last `forget()`, without the bus's own handshake. */
  asked(): string[];
  forget(): void;
  /** The items of one account, by the standard's three attributes. */
  itemsOf(email: string, site: string): StoreItem[];
  /** Plant an item as another program in the session would. */
  plant(email: string, site: string, secret: string): void;
  stop(): Promise<void>;
}

const HANDSHAKE = new Set(["Hello", "AddMatch"]);

/** Starts the stand-in bus and points the real client at it. `limitMs` shortens the client's 3 seconds. */
export async function startStore(
  initial: Partial<FakeStore["state"]> = {},
  limitMs?: number,
): Promise<FakeStore> {
  const bus = await startFakeBus(initial);
  setKeyringAccess({
    platform: "linux",
    env: bus.env,
    ...(limitMs ? { limitMs } : {}),
    promptMs: 500,
  });
  let from = 0;
  const attributesOf = (email: string, site: string) => ({
    ...signInItem(email, site),
    kind: "sign-in",
  });
  return {
    state: bus.state,
    calls: bus.calls,
    asked: () =>
      bus.calls
        .slice(from)
        .map((call: { member: string }) => call.member)
        .filter((member: string) => !HANDSHAKE.has(member)),
    forget: () => {
      from = bus.calls.length;
    },
    itemsOf: (email, site) => {
      const wanted = attributesOf(email, site);
      return (bus.state.items as StoreItem[]).filter((item) =>
        Object.entries(wanted).every(([key, value]) => item.attributes[key] === value),
      );
    },
    plant: (email, site, secret) => {
      const attributes = attributesOf(email, site);
      bus.state.items = (bus.state.items as StoreItem[]).filter(
        (item) => JSON.stringify(item.attributes) !== JSON.stringify(attributes),
      );
      bus.state.items.push({
        path: `/org/freedesktop/secrets/collection/login/planted${bus.state.items.length}`,
        attributes,
        label: "planted",
        secret,
        locked: false,
      });
    },
    stop: async () => {
      setKeyringAccess(SEALED);
      await bus.stop();
    },
  };
}

export interface FakeMac {
  /** ok | locked | denied | broken | deaf (says yes, saves nothing) | hang */
  mode(name: string): void;
  /** Every run of the stand-in: its arguments, its standard input, its whole environment. */
  calls(): Array<{ args: string[]; input: string; environment: string }>;
  /** The "keychain": `service|account` to what was saved. */
  keychain(): Record<string, { secret: string; label?: string; comment?: string }>;
  /** Put an item there as an earlier release of the tool did. */
  put(service: string, account: string, secret: string): void;
  stop(): void;
}

/**
 * A stand-in `security` command, and the client told it is on a Mac. It keeps
 * its "keychain" in a file, records how it was called (arguments and standard
 * input, never mixed up), and misbehaves when told to.
 */
export function startMac(limitMs?: number): FakeMac {
  const folder = mkdtempSync(join(tmpdir(), "krmac-"));
  const fake = join(folder, "security");
  writeFileSync(
    fake,
    `#!${process.execPath}
const fs = require("node:fs");
const dir = ${JSON.stringify(folder)};
const read = (name, otherwise) => { try { return fs.readFileSync(dir + "/" + name, "utf8"); } catch { return otherwise; } };
const mode = read("mode", "ok").trim();
const args = process.argv.slice(2);
const input = fs.readFileSync(0, "utf8");
fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify({ args, input, environment: JSON.stringify(process.env) }) + "\\n");
const chain = JSON.parse(read("keychain.json", "{}"));
const save = () => fs.writeFileSync(dir + "/keychain.json", JSON.stringify(chain));
const split = (line) => [...line.matchAll(/"((?:[^"\\\\]|\\\\.)*)"|(\\S+)/g)].map((m) => m[1] ?? m[2]);
const flag = (list, name) => (list.includes(name) ? list[list.indexOf(name) + 1] : undefined);
function run(list) {
  const key = flag(list, "-s") + "|" + flag(list, "-a");
  if (mode === "locked") return 36;
  if (mode === "denied") return 51;
  if (mode === "broken") return 1;
  if (list[0] === "find-generic-password") {
    if (!(key in chain)) return 44;
    process.stdout.write(chain[key].secret + "\\n");
    return 0;
  }
  if (list[0] === "add-generic-password") {
    if (mode === "deaf") return 0;
    if (key in chain && !list.includes("-U")) return 45;
    chain[key] = { secret: Buffer.from(flag(list, "-X"), "hex").toString("utf8"), label: flag(list, "-l"), comment: flag(list, "-j") };
    save();
    return 0;
  }
  if (list[0] === "delete-generic-password") {
    if (!(key in chain)) return 44;
    delete chain[key];
    save();
    return 0;
  }
  return 2;
}
if (mode === "hang") setInterval(() => {}, 1000);
else if (args[0] === "-i") {
  // Like the real one: a last line with no newline is dropped, and -i itself ends 0.
  for (const line of input.split("\\n").slice(0, -1)) if (line.length <= 4096) run(split(line));
  process.exit(0);
} else process.exit(run(args));
`,
  );
  chmodSync(fake, 0o755);
  setKeyringAccess({
    platform: "darwin",
    securityPath: fake,
    env: {},
    ...(limitMs ? { limitMs, promptMs: limitMs } : {}),
  });
  const chainFile = join(folder, "keychain.json");
  const keychain = () =>
    existsSync(chainFile) ? JSON.parse(readFileSync(chainFile, "utf8")) : {};
  return {
    mode: (name) => writeFileSync(join(folder, "mode"), name),
    calls: () =>
      existsSync(join(folder, "calls.jsonl"))
        ? readFileSync(join(folder, "calls.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
    keychain,
    put: (service, account, secret) =>
      writeFileSync(
        chainFile,
        JSON.stringify({ ...keychain(), [`${service}|${account}`]: { secret } }),
      ),
    stop: () => {
      setKeyringAccess(SEALED);
      if (folder.includes("/krmac-")) rmSync(folder, { recursive: true, force: true });
    },
  };
}
