/**
 * Where the API-token sign-in is kept (the Reposit keyring standard, release
 * A), through the tool's own commands.
 *
 * The password store is a stand-in; the CLIENT IS THE REAL ONE (see
 * test/helpers/passwordStore.ts). Atlassian is a stub: every request the tool
 * would send is recorded in `net`, so "nothing was sent" is checked, not
 * assumed. The token is made up.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stdin = vi.hoisted(() => ({ token: "" }));
vi.mock("../src/config.js", async (original) => ({
  ...(await original<typeof import("../src/config.js")>()),
  // The one thing a test cannot do as a person does: type the token.
  readTokenFromStdin: async () => stdin.token,
}));

const { main } = await import("../src/cli.js");
const { configPath, resolveAuthMode, saveOAuthSession, setKeychainBackend, signInLabel } =
  await import("../src/config.js");
const { fingerprint } = await import("../src/keyring.mjs");
const { startMac, startStore } = await import("./helpers/passwordStore.js");
type FakeStore = Awaited<ReturnType<typeof startStore>>;
type FakeMac = ReturnType<typeof startMac>;

const EMAIL = "lab.person@repositpower.com";
const SITE = "lab.atlassian.net";
const ACCOUNT = `${EMAIL}/${SITE}`;
/** Shaped like one of Atlassian's, and made up. */
const SECRET = "ATATT3xFfGF0-made_up-for-the-tests=0123456789abcdefABCDEF";
const PLANTED = "ATATT3xFfGF0-planted-by-another-program=0123456789abcdef";
const PRINT = fingerprint("confluence-axi", ACCOUNT, SECRET);
const LABEL = `Reposit agent tools: Confluence sign-in for ${ACCOUNT}`;
const BASIC = `Basic ${Buffer.from(`${EMAIL}:${SECRET}`).toString("base64")}`;

interface Ran {
  out: string;
  exit: number;
}

let tmp: string;
let net: Array<{ url: string; authorization: string }>;
let everything: string[];
let store: FakeStore | undefined;
let mac: FakeMac | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "axi-store-"));
  process.env["XDG_CONFIG_HOME"] = tmp;
  net = [];
  everything = [];
  stdin.token = SECRET;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    net.push({ url: String(url), authorization: headers["Authorization"] ?? "" });
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  });
});

afterEach(async () => {
  // Through all of it, the token was in nothing the tool said.
  for (const text of everything) {
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(PLANTED);
    expect(text).not.toContain(Buffer.from(SECRET).toString("hex"));
    expect(text).not.toContain(BASIC);
    // And it spoke to a person in a person's words. "keyring" is the name of
    // a flag value and of a command, and GNOME Keyring is a product; nothing else.
    const words = text
      .replace(/`[^`]*`/g, "")
      .replace(/(--store|auth store|store) keyring/g, "")
      // The two values named where a wrong one was given.
      .replace(/keyring or file|: keyring \(this computer's password store\)/g, "")
      // What the person typed, said back to them.
      .replace(/, not keyring[^"\n]*/g, "")
      // The shared client's own reason for a store with nothing to save into.
      .replace(/the password store has no keyring to put a sign-in in/g, "")
      .replace(/GNOME Keyring/g, "")
      .replace(/code: KEYRING_\w+|\(KEYRING_\w+\)/g, "");
    expect(words).not.toMatch(/d-bus|dbus|secret service|keyring/i);
  }
  await store?.stop();
  store = undefined;
  mac?.stop();
  mac = undefined;
  setKeychainBackend(undefined);
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  if (existsSync(dirname(configPath()))) chmodSync(dirname(configPath()), 0o700);
  rmSync(tmp, { recursive: true, force: true });
});

/** One run of the tool, as `main` runs it: what it printed, and how it ended. */
async function tool(...argv: string[]): Promise<Ran> {
  process.exitCode = undefined;
  const chunks: string[] = [];
  await main({ argv, stdout: { write: (chunk: string) => (chunks.push(chunk), true) } });
  const ran = { out: chunks.join(""), exit: Number(process.exitCode ?? 0) };
  process.exitCode = undefined;
  everything.push(ran.out);
  return ran;
}

const login = (...extra: string[]) =>
  tool("auth", "login", "--token", "--site", SITE, "--email", EMAIL, ...extra);
const settings = (): Record<string, unknown> =>
  JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
const settingsFolder = () =>
  readdirSync(dirname(configPath()))
    .map((name) => readFileSync(join(dirname(configPath()), name), "utf8"))
    .join("\n");
const writeSettings = (value: Record<string, unknown>) => {
  mkdirSync(dirname(configPath()), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};
/** A sign-in the settings say is in the password store, with a `token` PLANTED in the file. */
const keptInStoreWithPlantedFileToken = () =>
  writeSettings({
    site: SITE,
    email: EMAIL,
    store: "keyring",
    secret_fingerprint: PRINT,
    token: PLANTED,
  });
const secretsIn = (s: FakeStore) => s.itemsOf(EMAIL, SITE).map((item) => item.secret);

/**
 * Every command a help line names must run as written: it is a real command
 * of this tool, with flags that command takes, and no placeholder.
 */
function expectRunnable(out: string): void {
  const help = out.slice(out.indexOf("help["));
  const named = [...help.matchAll(/`(confluence-axi[^`]*)`/g)].map((m) => m[1] as string);
  for (const command of named) {
    expect(command, out).toMatch(
      /^confluence-axi auth (login( --token)?( --store (keyring|file))?|status( --check)?|store (keyring|file)|--help)$/,
    );
  }
}

// ---------------------------------------------------------------------------

describe("sign-in: where a new sign-in goes (release A)", () => {
  it("with no --store, goes exactly where it went before: the file, in the shape the previous release wrote, and says so", async () => {
    store = await startStore();
    const ran = await login();
    expect(ran.exit, ran.out).toBe(0);
    expect(ran.out).toContain("token-store: file");
    expect(ran.out).toContain(
      "sign_in: Your sign-in is kept in a private file on this computer.",
    );
    // Byte for byte what the release before this one writes, so it reads it.
    expect(settings()).toEqual({ site: SITE, email: EMAIL, token: SECRET });
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    // A usable password store was right there, and was not asked.
    expect(store.asked()).toEqual([]);
    expectRunnable(ran.out);
  });

  it("--store auto is the same as no flag", async () => {
    store = await startStore();
    const ran = await login("--store", "auto");
    expect(ran.exit, ran.out).toBe(0);
    expect(settings()).toEqual({ site: SITE, email: EMAIL, token: SECRET });
    expect(store.asked()).toEqual([]);
  });

  it("--store file records the file, its reason and the fingerprint", async () => {
    const ran = await login("--store", "file");
    expect(ran.exit, ran.out).toBe(0);
    expect(ran.out).toContain(
      "sign_in: Your sign-in is kept in a private file on this computer, as chosen at sign-in.",
    );
    expect(settings()).toEqual({
      site: SITE,
      email: EMAIL,
      token: SECRET,
      store: "file",
      store_reason: "chosen",
      secret_fingerprint: PRINT,
    });
  });

  it("--store keyring keeps the bare token in the password store and no token in the settings", async () => {
    store = await startStore();
    const ran = await login("--store", "keyring");
    expect(ran.exit, ran.out).toBe(0);
    expect(ran.out).toContain("token-store: password-store");
    // The stand-in bus is no named product, so the client calls it "a password store".
    expect(ran.out).toContain(
      "sign_in: Your sign-in is kept in this computer's password store (a password store).",
    );
    expect(settings()).toEqual({
      site: SITE,
      email: EMAIL,
      store: "keyring",
      secret_fingerprint: PRINT,
    });
    expect(settingsFolder()).not.toContain(SECRET);
    // One item: the standard's three names, a label a person recognises, the bare token.
    const items = store.itemsOf(EMAIL, SITE);
    expect(items).toHaveLength(1);
    expect(items[0]?.attributes).toEqual({
      service: "confluence-axi",
      account: ACCOUNT,
      kind: "sign-in",
    });
    expect(items[0]?.label).toBe(LABEL);
    expect(items[0]?.secret).toBe(SECRET);
    expect(signInLabel(EMAIL, SITE)).toBe(LABEL);
    expectRunnable(ran.out);
  });

  it("a later sign-in with no --store stays in the store the settings recorded", async () => {
    store = await startStore();
    await login("--store", "keyring");
    const next = "ATATT3xFfGF0-the-next-years-token=0123456789abcdefABCDEF";
    stdin.token = next;
    const ran = await login();
    expect(ran.exit, ran.out).toBe(0);
    expect(settings()["store"]).toBe("keyring");
    expect(settings()["token"]).toBeUndefined();
    expect(secretsIn(store)).toEqual([next]);
    expect(ran.out).not.toContain(next);
  });

  it.each([
    ["no session bus at all", undefined, "KEYRING_UNAVAILABLE"],
    ["a bus with no password store on it", { absent: true }, "KEYRING_UNAVAILABLE"],
    ["a store with no keyring in it", { alias: "/" }, "KEYRING_UNAVAILABLE"],
    ["a locked store nobody unlocks", { locked: true, prompt: "dismiss" as const }, "KEYRING_LOCKED"],
  ])("--store keyring with %s is refused, and writes nothing", async (_name, state, code) => {
    if (state) store = await startStore(state);
    const ran = await login("--store", "keyring");
    expect(ran.exit).toBe(1);
    expect(ran.out).toContain(`code: ${code}`);
    expect(existsSync(configPath())).toBe(false);
    if (store) expect(store.state.items).toEqual([]);
    expectRunnable(ran.out);
  });

  it("--store keyring that is refused leaves an earlier sign-in exactly as it was", async () => {
    await login();
    const before = readFileSync(configPath(), "utf8");
    store = await startStore({ locked: true, prompt: "dismiss" });
    stdin.token = PLANTED;
    const ran = await login("--store", "keyring");
    expect(ran.out).toContain("code: KEYRING_LOCKED");
    expect(readFileSync(configPath(), "utf8")).toBe(before);
  });

  it("--store takes auto, keyring or file and nothing else", async () => {
    const ran = await login("--store", "vault");
    expect(ran.exit).toBe(2);
    expect(ran.out).toContain("--store takes auto, keyring or file, not vault");
    expect(existsSync(configPath())).toBe(false);
    expectRunnable(ran.out);
  });

  it("signing in again works when the saved sign-in cannot be read (a locked store)", async () => {
    keptInStoreWithPlantedFileToken();
    store = await startStore({ locked: true });
    const ran = await login("--store", "file");
    expect(ran.exit, ran.out).toBe(0);
    expect(settings()).toMatchObject({ token: SECRET, store: "file", store_reason: "chosen" });
  });
});

// ---------------------------------------------------------------------------

describe("reading: the recorded store and no other", () => {
  const cases: Array<[string, Partial<FakeStore["state"]> | "never-answers" | "denied", string]> = [
    ["locked", { locked: true }, "KEYRING_LOCKED"],
    ["locked, and unable to list what it holds", { locked: true, searchWhenLocked: false }, "KEYRING_LOCKED"],
    ["refusing this session (a sandbox)", "denied", "KEYRING_BLOCKED"],
    ["not on the bus", { absent: true }, "KEYRING_UNAVAILABLE"],
    ["holding no such item", {}, "SIGN_IN_MISSING"],
    ["never answering", "never-answers", "KEYRING_FAILED"],
  ];

  it.each(cases)(
    "a password store that is %s stops the command with its code; the token planted in the file is not used and nothing is sent",
    async (_name, how, code) => {
      keptInStoreWithPlantedFileToken();
      if (how === "denied") {
        store = await startStore({
          on: { OpenSession: (ctx) => (ctx.error("org.freedesktop.DBus.Error.AccessDenied"), true) },
        });
      } else if (how === "never-answers") {
        store = await startStore({ on: { SearchItems: () => true } });
      } else {
        store = await startStore(how);
      }
      if (code !== "SIGN_IN_MISSING" && how !== "denied" && how !== "never-answers") {
        store.plant(EMAIL, SITE, SECRET);
      }
      const began = Date.now();
      const ran = await tool("space", "list");
      expect(ran.exit, ran.out).toBe(1);
      expect(ran.out).toContain(`code: ${code}`);
      expect(net).toEqual([]);
      // The 3 second limit: a store that never answers ends the command in under 4.
      expect(Date.now() - began).toBeLessThan(4000);
      // No password window was asked for.
      expect(store.asked()).not.toContain("Unlock");
      expect(store.asked()).not.toContain("Prompt");
      expectRunnable(ran.out);
    },
  );

  it("no session bus at all: KEYRING_UNAVAILABLE, and the planted file token is not used", async () => {
    keptInStoreWithPlantedFileToken();
    const ran = await tool("space", "list");
    expect(ran.out).toContain("code: KEYRING_UNAVAILABLE");
    expect(ran.out).toContain("auth login --token --store file");
    expect(net).toEqual([]);
  });

  it("a swapped item is refused with SIGN_IN_MISMATCH and no request is sent", async () => {
    keptInStoreWithPlantedFileToken();
    store = await startStore();
    store.plant(EMAIL, SITE, PLANTED);
    const ran = await tool("space", "list");
    expect(ran.exit).toBe(1);
    expect(ran.out).toContain("code: SIGN_IN_MISMATCH");
    expect(ran.out).toContain("so it was not used and nothing was sent");
    expect(net).toEqual([]);
  });

  it("a keyring sign-in with no fingerprint in the settings is refused", async () => {
    writeSettings({ site: SITE, email: EMAIL, store: "keyring" });
    store = await startStore();
    store.plant(EMAIL, SITE, SECRET);
    expect((await tool("space", "list")).out).toContain("code: SIGN_IN_MISMATCH");
    expect(net).toEqual([]);
  });

  it("a store this version does not know is SIGN_IN_STORE_UNKNOWN, not the file", async () => {
    writeSettings({ site: SITE, email: EMAIL, store: "vault", token: PLANTED });
    const ran = await tool("space", "list");
    expect(ran.out).toContain("code: SIGN_IN_STORE_UNKNOWN");
    expect(net).toEqual([]);
    expect((await tool("auth", "store", "keyring")).out).toContain("code: SIGN_IN_STORE_UNKNOWN");
    expect((await tool("auth", "store", "file")).out).toContain("code: SIGN_IN_STORE_UNKNOWN");
  });

  it("a recorded file whose token was changed is refused with SIGN_IN_MISMATCH", async () => {
    writeSettings({
      site: SITE,
      email: EMAIL,
      store: "file",
      store_reason: "chosen",
      secret_fingerprint: PRINT,
      token: PLANTED,
    });
    expect((await tool("space", "list")).out).toContain("code: SIGN_IN_MISMATCH");
    expect(net).toEqual([]);
  });

  it("the matching item is used, among duplicates another program planted beside it", async () => {
    keptInStoreWithPlantedFileToken();
    store = await startStore();
    store.plant(EMAIL, SITE, SECRET);
    store.state.items.push({
      path: "/org/freedesktop/secrets/collection/login/extra",
      attributes: { service: "confluence-axi", account: ACCOUNT, kind: "sign-in" },
      secret: PLANTED,
    });
    const ran = await tool("space", "list");
    expect(ran.exit, ran.out).toBe(0);
    expect(net.map((request) => request.authorization)).toEqual([BASIC]);
  });

  it("an old Linux file, saved before the standard, works unchanged and asks no password store", async () => {
    // A real file of the release before this one: nothing but these three keys.
    writeSettings({ site: SITE, email: EMAIL, token: SECRET });
    const before = readFileSync(configPath(), "utf8");
    store = await startStore();
    const ran = await tool("space", "list");
    expect(ran.exit, ran.out).toBe(0);
    expect(net.map((request) => request.authorization)).toEqual([BASIC]);
    expect(store.asked()).toEqual([]);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
    const status = await tool("auth", "status");
    expect(status.out).toContain("token: present (config)");
    expect(status.out).toContain("sign_in: private file");
  });
});

// ---------------------------------------------------------------------------

describe("the environment sign-in", () => {
  afterEach(() => {
    delete process.env["ATLASSIAN_API_TOKEN"];
  });

  it("still wins, is stated, asks no store and writes nothing anywhere", async () => {
    keptInStoreWithPlantedFileToken();
    const before = readFileSync(configPath(), "utf8");
    store = await startStore();
    store.plant(EMAIL, SITE, PLANTED);
    const env = "ATATT3xFfGF0-from-the-environment=0123456789";
    process.env["ATLASSIAN_API_TOKEN"] = env;

    const ran = await tool("space", "list");
    expect(ran.exit, ran.out).toBe(0);
    expect(net[0]?.authorization).toBe(
      `Basic ${Buffer.from(`${EMAIL}:${env}`).toString("base64")}`,
    );
    const status = await tool("auth", "status", "--check");
    expect(status.exit, status.out).toBe(0);
    expect(status.out).toContain("token: present (env)");
    expect(status.out).toContain("sign_in: environment (ATLASSIAN_API_TOKEN, saved nowhere)");
    expect(status.out).toContain(
      "sign_in_store: environment variable ATLASSIAN_API_TOKEN: used as it is, and saved nowhere on this computer",
    );
    expect((await tool()).out).toContain("sign_in: environment");

    expect(store.asked()).toEqual([]);
    expect(secretsIn(store)).toEqual([PLANTED]);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
    for (const text of everything) expect(text).not.toContain(env);
  });
});

// ---------------------------------------------------------------------------

describe("everyday commands, auth status and the home view", () => {
  beforeEach(async () => {
    store = await startStore();
    await login("--store", "keyring");
    store.forget();
    net.length = 0;
  });

  it("the home view never asks the password store: it says where the sign-in is from the settings alone", async () => {
    // Even one that would never answer: a session start must not wait on it.
    store!.state.on["SearchItems"] = () => true;
    const began = Date.now();
    const home = await tool();
    expect(Date.now() - began).toBeLessThan(1000);
    expect(home.exit, home.out).toBe(0);
    expect(home.out).toContain(`site: ${SITE}`);
    expect(home.out).toContain("auth: signed in (api-token, not read here");
    expect(home.out).toContain("sign_in: password store");
    expect(store!.asked()).toEqual([]);
    expect(net).toEqual([]);
  });

  it("auth status never asks the password store, and says it checked nothing", async () => {
    const status = await tool("auth", "status");
    expect(status.exit, status.out).toBe(0);
    expect(status.out).toContain("status: not checked");
    expect(status.out).toContain("sign_in: password store");
    expect(status.out).toContain("confluence: not checked");
    expect(store!.asked()).toEqual([]);
    expect(net).toEqual([]);
    expectRunnable(status.out);
  });

  it("an everyday command reads the token and never writes: not the password store, not the settings folder (read-only here)", async () => {
    const folder = dirname(configPath());
    const before = settingsFolder();
    chmodSync(configPath(), 0o400);
    chmodSync(folder, 0o500);
    const ran = await tool("space", "list");
    chmodSync(folder, 0o700);
    expect(ran.exit, ran.out).toBe(0);
    expect(net.map((request) => request.authorization)).toEqual([BASIC]);
    for (const write of ["CreateItem", "Delete", "Unlock", "Prompt", "Lock"]) {
      expect(store!.asked()).not.toContain(write);
    }
    expect(settingsFolder()).toBe(before);
    expect(readdirSync(folder)).toEqual(["config.json"]);
  });
});

// ---------------------------------------------------------------------------

describe("auth status --check: the sign_in_store row", () => {
  it("password store, item there, fingerprint matches: ok, and Confluence is checked", async () => {
    store = await startStore();
    await login("--store", "keyring");
    net.length = 0;
    const ran = await tool("auth", "status", "--check");
    expect(ran.exit, ran.out).toBe(0);
    expect(ran.out).toContain("status: ok");
    expect(ran.out).toContain("token: present (password-store)");
    expect(ran.out).toContain("sign_in_store: password store (a password store): ok");
    expect(ran.out).toContain("confluence: 200 ok");
    expect(net.map((request) => request.authorization)).toEqual([BASIC]);
  });

  it.each<[string, (s: FakeStore) => void, string, string]>([
    [
      "locked",
      (s) => void (s.state.locked = true),
      "KEYRING_LOCKED",
      "sign_in_store: password store: locked. Unlock it, then run this again",
    ],
    [
      "blocked",
      (s) =>
        void (s.state.on["OpenSession"] = (ctx) => (
          ctx.error("org.freedesktop.DBus.Error.AccessDenied"), true
        )),
      "KEYRING_BLOCKED",
      "sign_in_store: password store: cannot be reached from inside a sandbox. Run this command outside the sandbox",
    ],
    [
      "item missing",
      (s) => void (s.state.items = []),
      "SIGN_IN_MISSING",
      "sign_in_store: password store: the saved sign-in is not there. A person runs `confluence-axi auth login --token`",
    ],
    [
      "item not matching",
      (s) => s.plant(EMAIL, SITE, PLANTED),
      "SIGN_IN_MISMATCH",
      "sign_in_store: password store: the saved sign-in is not there. A person runs `confluence-axi auth login --token`",
    ],
    [
      "gone from the session",
      (s) => void (s.state.absent = true),
      "KEYRING_UNAVAILABLE",
      "sign_in_store: password store: Your sign-in is kept in this computer's password store, and this session has none to ask",
    ],
  ])("password store, %s: needs attention, exits 1, sends nothing", async (_name, arrange, code, row) => {
    store = await startStore();
    await login("--store", "keyring");
    net.length = 0;
    arrange(store);
    const ran = await tool("auth", "status", "--check");
    expect(ran.exit, ran.out).toBe(1);
    expect(ran.out).toContain(`code: ${code}`);
    expect(ran.out).toContain(row);
    expect(net).toEqual([]);
    expect(store.asked()).not.toContain("Unlock");
    expectRunnable(ran.out);
  });

  it("file, and a password store is usable now: says how to move, and what that costs", async () => {
    store = await startStore();
    await login();
    const ran = await tool("auth", "status", "--check");
    expect(ran.exit, ran.out).toBe(0);
    expect(ran.out).toContain(
      "sign_in_store: private file. A password store is available: `confluence-axi auth store keyring` moves the sign-in there (after which no command of this tool works inside an agent sandbox)",
    );
    // It asked whether there is one, and nothing more.
    expect(store.asked()).not.toContain("SearchItems");
    expect(store.asked()).not.toContain("CreateItem");
  });

  it("file, chosen, and no password store here: private file, as chosen at sign-in", async () => {
    await login("--store", "file");
    const ran = await tool("auth", "status", "--check");
    expect(ran.exit, ran.out).toBe(0);
    expect(ran.out).toContain("sign_in_store: private file, as chosen at sign-in");
  });

  it("file, for a reason other than chosen: private file, because (the reason in words)", async () => {
    writeSettings({
      site: SITE,
      email: EMAIL,
      token: SECRET,
      store: "file",
      store_reason: "locked",
      secret_fingerprint: PRINT,
    });
    const ran = await tool("auth", "status", "--check");
    expect(ran.out).toContain(
      "sign_in_store: private file, because the password store was locked",
    );
  });

  it("file, from before the standard, and no password store here", async () => {
    await login();
    const ran = await tool("auth", "status", "--check");
    expect(ran.out).toMatch(/^\s*sign_in_store: private file$/m);
  });
});

// ---------------------------------------------------------------------------

describe("auth store keyring | file", () => {
  it("keyring: the item is proven BEFORE the settings change, and the file then holds no token", async () => {
    await login();
    store = await startStore();
    let settingsWhenItemWritten = "";
    const real = store.state.on["CreateItem"];
    store.state.on["CreateItem"] = () => {
      settingsWhenItemWritten = readFileSync(configPath(), "utf8");
      return real?.({} as never) ?? false;
    };
    const ran = await tool("auth", "store", "keyring");
    expect(ran.exit, ran.out).toBe(0);
    // The first line is what `reposit-agent-tools update` shows a person.
    expect(ran.out.split("\n")[0]).toBe(
      "sign_in: Your sign-in is kept in this computer's password store (a password store).",
    );
    expect(ran.out).toContain("moved: yes");
    expect(JSON.parse(settingsWhenItemWritten)).toEqual({ site: SITE, email: EMAIL, token: SECRET });
    expect(settings()).toEqual({
      site: SITE,
      email: EMAIL,
      store: "keyring",
      secret_fingerprint: PRINT,
    });
    expect(secretsIn(store)).toEqual([SECRET]);
    expect(settingsFolder()).not.toContain(SECRET);
    // One rename: no half-written file is left beside it.
    expect(readdirSync(dirname(configPath()))).toEqual(["config.json"]);
    expect((await tool("space", "list")).exit).toBe(0);
    expectRunnable(ran.out);
  });

  it("keyring: killed between the two steps, then run again, ends with the token in exactly one place", async () => {
    await login();
    store = await startStore();
    // The settings file's rename cannot happen: the run dies after the item is written.
    const inTheWay = `${configPath()}.${process.pid}.tmp`;
    mkdirSync(inTheWay);
    const killed = await tool("auth", "store", "keyring");
    expect(killed.exit).toBe(1);
    // Both places, which is harmless: the settings still say the file, and the tool works.
    expect(secretsIn(store)).toEqual([SECRET]);
    expect(settings()).toEqual({ site: SITE, email: EMAIL, token: SECRET });
    expect((await tool("space", "list")).exit).toBe(0);

    rmSync(inTheWay, { recursive: true });
    const again = await tool("auth", "store", "keyring");
    expect(again.exit, again.out).toBe(0);
    expect(again.out).toContain("moved: yes");
    expect(secretsIn(store)).toEqual([SECRET]);
    expect(settings()["token"]).toBeUndefined();
    expect(settingsFolder()).not.toContain(SECRET);
  });

  it.each<[string, Partial<FakeStore["state"]> | undefined, string]>([
    ["no password store in this session", undefined, "KEYRING_UNAVAILABLE"],
    ["a locked one nobody unlocks", { locked: true, prompt: "dismiss" }, "KEYRING_LOCKED"],
  ])("keyring with %s changes nothing, says where the sign-in still is and why, and is not an error", async (_name, state, code) => {
    await login();
    const before = readFileSync(configPath(), "utf8");
    if (state) store = await startStore(state);
    const ran = await tool("auth", "store", "keyring");
    expect(ran.exit, ran.out).toBe(0);
    expect(ran.out.split("\n")[0]).toBe(
      `sign_in: Your sign-in is kept in a private file on this computer. It was not moved: this computer's password store could not be used (${code}).`,
    );
    expect(ran.out).toContain("moved: no");
    expect(ran.out).toContain("why: Your sign-in is kept in this computer's password store");
    expect(readFileSync(configPath(), "utf8")).toBe(before);
    if (store) expect(store.state.items).toEqual([]);
    expectRunnable(ran.out);
  });

  it("keyring, when it is already there: read and matched before saying so", async () => {
    store = await startStore();
    await login("--store", "keyring");
    const ran = await tool("auth", "store", "keyring");
    expect(ran.out).toContain("It was already there.");
    expect(ran.out).toContain("moved: no");
    store.plant(EMAIL, SITE, PLANTED);
    expect((await tool("auth", "store", "keyring")).out).toContain("code: SIGN_IN_MISMATCH");
  });

  it("file: the token is back in the file BEFORE the item is removed, in a file the previous release reads", async () => {
    store = await startStore();
    await login("--store", "keyring");
    let settingsWhenItemRemoved: Record<string, unknown> = {};
    store.state.on["Delete"] = () => {
      settingsWhenItemRemoved = settings();
      return false;
    };
    const ran = await tool("auth", "store", "file");
    expect(ran.exit, ran.out).toBe(0);
    expect(ran.out.split("\n")[0]).toBe(
      "sign_in: Your sign-in is kept in a private file on this computer, as chosen at sign-in.",
    );
    expect(ran.out).toContain("moved: yes");
    expect(settingsWhenItemRemoved).toMatchObject({ token: SECRET, store: "file" });
    // The previous release reads `site`, `email` and `token`, and ignores the rest.
    expect(settings()).toEqual({
      site: SITE,
      email: EMAIL,
      token: SECRET,
      store: "file",
      store_reason: "chosen",
      secret_fingerprint: PRINT,
    });
    expect(store.itemsOf(EMAIL, SITE)).toEqual([]);
    expect((await tool("space", "list")).exit).toBe(0);
    expectRunnable(ran.out);
  });

  it("file: an item that cannot be removed is said, with its label; running it again finishes the job", async () => {
    store = await startStore();
    await login("--store", "keyring");
    store.state.on["Delete"] = (ctx) => (ctx.error("org.freedesktop.DBus.Error.Failed"), true);
    const ran = await tool("auth", "store", "file");
    expect(ran.exit, ran.out).toBe(0);
    expect(ran.out).toContain("could not be removed");
    expect(ran.out).toContain(`look for "${LABEL}"`);
    expect(settings()).toMatchObject({ token: SECRET, store: "file" });
    expect(secretsIn(store)).toEqual([SECRET]);

    delete store.state.on["Delete"];
    const again = await tool("auth", "store", "file");
    expect(again.out).toContain("It was already there.");
    expect(again.out).toContain("a copy left in this computer's password store was removed");
    expect(store.itemsOf(EMAIL, SITE)).toEqual([]);
    expect(settings()["token"]).toBe(SECRET);
  });

  it.each<[string, (s: FakeStore) => void, string]>([
    ["locked", (s) => void (s.state.locked = true), "KEYRING_LOCKED"],
    ["swapped", (s) => s.plant(EMAIL, SITE, PLANTED), "SIGN_IN_MISMATCH"],
  ])("file, from a store that is %s: the standard's error, and nothing changes", async (_name, arrange, code) => {
    store = await startStore();
    await login("--store", "keyring");
    const before = readFileSync(configPath(), "utf8");
    arrange(store);
    const ran = await tool("auth", "store", "file");
    expect(ran.exit).toBe(1);
    expect(ran.out).toContain(`code: ${code}`);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
  });

  it("with the settings folder read-only (a sandbox), neither move writes an item, and the help names the command to run outside it", async () => {
    await login();
    store = await startStore();
    chmodSync(dirname(configPath()), 0o500);
    const ran = await tool("auth", "store", "keyring");
    chmodSync(dirname(configPath()), 0o700);
    expect(ran.exit).toBe(1);
    expect(ran.out).toContain("code: SETTINGS_NOT_WRITABLE");
    expect(ran.out).toContain("`confluence-axi auth store keyring`");
    expect(store.state.items).toEqual([]);
    expectRunnable(ran.out);
  });

  it("takes keyring or file and nothing else, and says so with commands that run", async () => {
    for (const args of [[], ["vault"], ["keyring", "--account", "x"]]) {
      const ran = await tool("auth", "store", ...args);
      expect(ran.exit).toBe(2);
      expect(ran.out).toContain("code: VALIDATION_ERROR");
      expectRunnable(ran.out);
    }
  });

  it("with nobody signed in, says so and names the sign-in command", async () => {
    const ran = await tool("auth", "store", "keyring");
    expect(ran.exit).toBe(1);
    expect(ran.out).toContain("There is no API-token sign-in on this computer to move");
    expectRunnable(ran.out);
  });
});

// ---------------------------------------------------------------------------

describe("auth logout", () => {
  it("removes the item as well as the settings", async () => {
    store = await startStore();
    await login("--store", "keyring");
    const ran = await tool("auth", "logout");
    expect(ran.exit, ran.out).toBe(0);
    expect(ran.out).toContain("the sign-in was removed from this computer's password store");
    expect(store.itemsOf(EMAIL, SITE)).toEqual([]);
    expect(existsSync(configPath())).toBe(false);
  });

  it("with the store locked, the settings still go, and the item it could not remove is named", async () => {
    store = await startStore();
    await login("--store", "keyring");
    store.state.locked = true;
    const ran = await tool("auth", "logout");
    expect(ran.exit, ran.out).toBe(0);
    expect(ran.out).toContain("could NOT be removed from this computer's password store");
    expect(ran.out).toContain(`look for "${LABEL}"`);
    expect(existsSync(configPath())).toBe(false);
    expect(store.asked()).not.toContain("Unlock");
  });
});

// ---------------------------------------------------------------------------

describe("the browser (OAuth) sign-in is unchanged: always the file", () => {
  const session = {
    clientId: "client-123",
    accessToken: "access-token-made-up",
    refreshToken: "refresh-token-made-up",
    expiresAt: Date.now() + 3_600_000,
    cloudId: "11111111-2222-3333-4444-555555555555",
    site: SITE,
    scopes: "read:confluence-content.all offline_access",
  };

  it("wins over a stored API token without asking the password store, even a locked one", async () => {
    keptInStoreWithPlantedFileToken();
    saveOAuthSession(session);
    store = await startStore({ locked: true });
    const mode = await resolveAuthMode();
    expect(mode).toMatchObject({ mode: "oauth", signIn: "private file" });
    const ran = await tool("space", "list");
    expect(ran.exit, ran.out).toBe(0);
    expect(net[0]?.authorization).toBe(`Bearer ${session.accessToken}`);
    expect(net[0]?.url).toContain(`/ex/confluence/${session.cloudId}/`);
    expect(store.asked()).toEqual([]);
    // Saving the session kept what says where the API token is.
    expect(settings()).toMatchObject({ store: "keyring", secret_fingerprint: PRINT });
  });

  it("is not moved by auth store keyring, which says why", async () => {
    saveOAuthSession(session);
    store = await startStore();
    const before = readFileSync(configPath(), "utf8");
    const ran = await tool("auth", "store", "keyring");
    expect(ran.exit, ran.out).toBe(0);
    expect(ran.out).toContain("moved: no");
    expect(ran.out).toContain("Your browser sign-in is kept in a private file on this computer, and stays there");
    expect(readFileSync(configPath(), "utf8")).toBe(before);
    expect(store.state.items).toEqual([]);
    const check = await tool("auth", "status", "--check");
    expect(check.out).toContain("sign_in_store: private file, as chosen at sign-in");
  });

  it("auth login --store keyring without --token is refused before any browser", async () => {
    const ran = await tool("auth", "login", "--store", "keyring");
    expect(ran.exit).toBe(2);
    expect(ran.out).toContain("A browser sign-in cannot be kept in this computer's password store");
    expectRunnable(ran.out);
  });
});

// ---------------------------------------------------------------------------

describe("a Mac (a stand-in `security`: THIS IS NOT A TEST ON A MAC)", () => {
  const OLD = "atlassian-axi|api-token";
  const NEW = `confluence-axi|${ACCOUNT}`;
  const hex = Buffer.from(SECRET).toString("hex");

  /** The token is in no argument list and no environment, of any run of `security`. */
  function expectNeverAnArgument(m: FakeMac): void {
    for (const call of m.calls()) {
      for (const secret of [SECRET, hex, PLANTED]) {
        expect(call.args.join(" ")).not.toContain(secret);
        expect(call.environment).not.toContain(secret);
      }
    }
  }

  it("a plain sign-in still goes to the keychain item the previous release reads, and the token is in no argument list", async () => {
    mac = startMac();
    const ran = await login();
    expect(ran.exit, ran.out).toBe(0);
    expect(ran.out).toContain("token-store: keychain");
    expect(ran.out).toContain(
      "sign_in: Your sign-in is kept in this computer's password store (the Mac keychain, under this tool's earlier item name).",
    );
    expect(mac.keychain()[OLD]?.secret).toBe(SECRET);
    // What the previous release wrote, and so reads: no token, nothing else.
    expect(settings()).toEqual({ site: SITE, email: EMAIL });
    // It went down standard input, as hex.
    expect(mac.calls().some((call) => call.args[0] === "-i" && call.input.includes(hex))).toBe(true);
    expectNeverAnArgument(mac);
    expect((await tool("space", "list")).exit).toBe(0);
    expect(net.at(-1)?.authorization).toBe(BASIC);
  });

  it.each(["deaf", "locked", "broken"])(
    "a failed write at sign-in (%s) ends in the file, STATED and recorded",
    async (how) => {
      mac = startMac(300);
      mac.put("atlassian-axi", "api-token", PLANTED); // what an earlier sign-in left
      mac.mode(how);
      const ran = await login();
      expect(ran.exit, ran.out).toBe(0);
      expect(ran.out).toContain("token-store: file");
      expect(ran.out).toMatch(
        /sign_in: Your sign-in is kept in a private file on this computer, because the password store (was locked|did not answer properly)\./,
      );
      expect(settings()).toMatchObject({
        token: SECRET,
        store: "file",
        store_reason: how === "locked" ? "locked" : "failed",
        secret_fingerprint: PRINT,
      });
      expectNeverAnArgument(mac);
      // Recorded, so the stale item the failed write left is never read again.
      mac.mode("ok");
      expect((await tool("space", "list")).exit).toBe(0);
      expect(net.at(-1)?.authorization).toBe(BASIC);
    },
  );

  it("--store keyring that fails is a refusal that writes nothing", async () => {
    mac = startMac(300);
    mac.mode("deaf");
    const ran = await login("--store", "keyring");
    expect(ran.exit).toBe(1);
    expect(ran.out).toContain("code: KEYRING_FAILED");
    expect(existsSync(configPath())).toBe(false);
    expect(mac.keychain()).toEqual({});
    expectNeverAnArgument(mac);
  });

  it("an old Mac item keeps working unchanged", async () => {
    mac = startMac();
    mac.put("atlassian-axi", "api-token", SECRET);
    writeSettings({ site: SITE, email: EMAIL });
    const ran = await tool("space", "list");
    expect(ran.exit, ran.out).toBe(0);
    expect(net[0]?.authorization).toBe(BASIC);
    expect((await tool("auth", "status")).out).toContain("token: present (keychain)");
  });

  it("a keychain that is locked or does not answer is an error now, not a reason to try the file", async () => {
    mac = startMac(300);
    mac.put("atlassian-axi", "api-token", SECRET);
    writeSettings({ site: SITE, email: EMAIL, token: PLANTED });
    for (const [how, code] of [
      ["locked", "KEYRING_LOCKED"],
      ["broken", "KEYRING_FAILED"],
      ["hang", "KEYRING_FAILED"],
    ] as const) {
      mac.mode(how);
      const ran = await tool("space", "list");
      expect(ran.exit, how).toBe(1);
      expect(ran.out).toContain(`code: ${code}`);
    }
    expect(net).toEqual([]);
    // Nothing in the keychain is still "nothing there": the file is read, as before.
    mac.mode("ok");
    writeSettings({ site: SITE, email: EMAIL, token: SECRET });
    await tool("auth", "store", "file"); // takes the old item into the file and removes it
    expect(mac.keychain()).toEqual({});
    writeSettings({ site: SITE, email: EMAIL, token: SECRET });
    expect((await tool("space", "list")).exit).toBe(0);
    expect(net.at(-1)?.authorization).toBe(BASIC);
  });

  it("an old Mac item is moved once by auth store keyring, and removed after the new one is proven", async () => {
    mac = startMac();
    mac.put("atlassian-axi", "api-token", SECRET);
    writeSettings({ site: SITE, email: EMAIL });
    const ran = await tool("auth", "store", "keyring");
    expect(ran.exit, ran.out).toBe(0);
    expect(ran.out).toContain("moved: yes");
    expect(mac.keychain()).toEqual({
      [NEW]: {
        secret: SECRET,
        label: LABEL,
        comment: "Removing this signs the tool out.",
      },
    });
    expect(settings()).toEqual({
      site: SITE,
      email: EMAIL,
      store: "keyring",
      secret_fingerprint: PRINT,
    });
    // The new item was written and read back before the old one was deleted.
    const order = mac.calls().map((call) => (call.args[0] === "-i" ? "add" : call.args[0]));
    expect(order.indexOf("delete-generic-password")).toBeGreaterThan(order.lastIndexOf("add"));
    expectNeverAnArgument(mac);
    expect((await tool("space", "list")).exit).toBe(0);
    // Once: there is nothing left to move.
    expect((await tool("auth", "store", "keyring")).out).toContain("It was already there.");
    expect(Object.keys(mac.keychain())).toEqual([NEW]);
  });

  it("an old Mac item whose new home cannot be proven is not removed, and nobody is signed out", async () => {
    mac = startMac(300);
    mac.put("atlassian-axi", "api-token", SECRET);
    writeSettings({ site: SITE, email: EMAIL });
    mac.mode("deaf");
    const ran = await tool("auth", "store", "keyring");
    expect(ran.exit, ran.out).toBe(0);
    expect(ran.out).toContain("moved: no");
    expect(mac.keychain()).toEqual({ [OLD]: { secret: SECRET } });
    expect(settings()).toEqual({ site: SITE, email: EMAIL });
  });

  it("auth store file takes an old Mac item into the file, then removes it", async () => {
    mac = startMac();
    mac.put("atlassian-axi", "api-token", SECRET);
    writeSettings({ site: SITE, email: EMAIL });
    const ran = await tool("auth", "store", "file");
    expect(ran.exit, ran.out).toBe(0);
    expect(ran.out).toContain("moved: yes");
    expect(settings()).toMatchObject({ token: SECRET, store: "file", store_reason: "chosen" });
    expect(mac.keychain()).toEqual({});
  });

  it("auth logout removes both items", async () => {
    mac = startMac();
    await login("--store", "keyring");
    mac.put("atlassian-axi", "api-token", PLANTED);
    const ran = await tool("auth", "logout");
    expect(ran.exit, ran.out).toBe(0);
    expect(mac.keychain()).toEqual({});
    expect(existsSync(configPath())).toBe(false);
  });
});
