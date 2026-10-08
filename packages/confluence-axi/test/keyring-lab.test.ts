/**
 * THE REAL THING, in a lab: the tool itself, as a separate program, against
 * real GNOME Keyring on a private session bus in a throwaway home
 * (test/helpers/keyringLab.ts). Sign in to the file, move the sign-in into the
 * password store, use it, refuse a swapped item, move it back, sign out; then
 * the same store locked.
 *
 * Run twice: from the source, and from THE PACKAGE, built here with the
 * command `build_atlassian` runs in scripts/package-tools of
 * Marl0nL/staff-agent-toolkit (`pnpm build`, which is `tsup`). Staff get the
 * package, and the copied client must behave the same once tsup has bundled
 * it. Set CONFLUENCE_AXI_LAB_BIN to a `dist/bin/confluence-axi.js` that
 * packaging itself produced to run the second pass against that file.
 *
 * NOTHING HERE CAN REACH A REAL PASSWORD STORE. Every copy of the tool is
 * started with the lab's environment and nothing else, through a preload that
 * refuses to run outside a lab (test/helpers/keyring-lab-preload.mjs); every
 * call this file makes itself is given the lab's environment, after `guard`.
 * Confluence is a stand-in on a loopback port, the site's name is under
 * `.invalid`, and Atlassian is never asked anything. The token is made up.
 *
 * ROLLBACK. Set CONFLUENCE_AXI_PREVIOUS_BIN to a build of the release BEFORE
 * this one (main at 794d544: `pnpm build`, then its
 * packages/confluence-axi/dist/bin/confluence-axi.js) and the same run also
 * starts THAT program against the settings this release wrote: it must read a
 * plain sign-in and one moved back with `auth store file`, and it cannot read
 * one that is in the password store (which is why `auth store file` comes
 * first on a machine that is going back). Not set in CI: there is no previous
 * build there, and those steps say so by not running.
 *
 * Skipped where GNOME Keyring and dbus-daemon are not installed; in CI they
 * are installed for this (.github/workflows/ci.yml) and their absence is a
 * failure. Linux only: the client's Mac path has never been run on a Mac.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signInItem, signInLabel } from "../src/config.js";
import { fingerprint, lookup, store } from "../src/keyring.mjs";
import { findProgram, guard, labMissing, startLab, type Lab } from "./helpers/keyringLab.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "confluence.lab.invalid";
const WHO = "lab.person@repositpower.com";
/** Shaped like one of Atlassian's, and made up. */
const SECRET = "ATATT3xFfGF0-made_up-for-the-keyring-lab=0123456789abcdefABCDEF";
const PLANTED = "ATATT3xFfGF0-planted-by-another-program-in-the-session=01234567";
const BASIC = `Basic ${Buffer.from(`${WHO}:${SECRET}`).toString("base64")}`;
const PRINT = fingerprint("confluence-axi", `${WHO}/${SITE}`, SECRET);
const PRELOAD = join(root, "test/helpers/keyring-lab-preload.mjs");

const missing = labMissing();
if (missing && process.env["CI"]) {
  throw new Error(`the keyring lab cannot run in CI, which installs what it needs: ${missing}`);
}

/** Confluence, in miniature, on a loopback port: it knows one token. */
async function fakeConfluence(): Promise<{
  url: string;
  requests: Array<{ path: string; authorization: string }>;
  server: Server;
}> {
  const requests: Array<{ path: string; authorization: string }> = [];
  const server = createServer((request, response) => {
    const authorization = String(request.headers["authorization"] ?? "");
    requests.push({ path: request.url ?? "", authorization });
    const ok = authorization === BASIC;
    response.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(
        ok
          ? { results: [{ id: "1", key: "LAB", name: "The lab", type: "global" }] }
          : { message: "no" },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    server,
  };
}

/** The package's binary, built the way `build_atlassian` builds it for a release. */
function buildPackage(): { bin: string; scratch?: string } {
  const given = process.env["CONFLUENCE_AXI_LAB_BIN"];
  if (given) return { bin: given };
  // Inside the package, so the bundle finds `axi-sdk-js` (its one runtime
  // dependency, which stays outside the bundle) and the package.json beside it.
  const scratch = mkdtempSync(join(root, ".lab-dist-"));
  // tsup is the workspace's, as `pnpm build` finds it.
  const tsup = [root, join(root, "..", "..")]
    .map((folder) => join(folder, "node_modules/.bin/tsup"))
    .find((candidate) => existsSync(candidate));
  const built = spawnSync(tsup ?? "tsup", ["--out-dir", scratch], {
    cwd: root,
    encoding: "utf8",
  });
  if (built.status !== 0) {
    if (scratch.includes("/.lab-dist-")) rmSync(scratch, { recursive: true, force: true });
    throw new Error(`tsup failed: ${built.error ?? ""}${built.stdout}${built.stderr}`);
  }
  return { bin: join(scratch, "bin", "confluence-axi.js"), scratch };
}

interface Ran {
  output: string;
  errors: string;
  status: number | null;
  ms: number;
}

describe.skipIf(missing !== null).each(["the source", "the package"] as const)(
  "the tool against a real password store, in a lab: %s",
  (variant) => {
    let lab: Lab;
    let confluence: Awaited<ReturnType<typeof fakeConfluence>>;
    let scratch: string | undefined;
    let entry: string[];
    let env: Record<string, string>;
    const everything: string[] = [];

    beforeAll(async () => {
      if (variant === "the package") {
        const built = buildPackage();
        scratch = built.scratch;
        entry = [built.bin];
      } else {
        entry = ["--import", "tsx", join(root, "src/bin/confluence-axi.ts")];
      }
      confluence = await fakeConfluence();
      lab = await startLab();
      env = { ...lab.env, REPOSIT_KEYRING_LAB_CONFLUENCE: confluence.url };
      guard(env);
    }, 120_000);

    afterAll(async () => {
      await lab?.stop();
      if (confluence) await new Promise((resolve) => confluence.server.close(resolve));
      // Only ever the folder this run made a moment ago, by its own name.
      if (scratch?.includes("/.lab-dist-")) rmSync(scratch, { recursive: true, force: true });
    });

    /** One run of the tool, as its own program, inside the lab. `input` is its standard input. */
    async function tool(args: string[], input = ""): Promise<Ran> {
      guard(env);
      const before = Date.now();
      const child = spawn(process.execPath, ["--import", PRELOAD, ...entry, ...args], {
        env,
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000,
      });
      let output = "";
      let errors = "";
      child.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString("utf8")));
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
      child.stdin.end(input);
      const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
      everything.push(args.join(" "), output, errors);
      return { output, errors, status, ms: Date.now() - before };
    }

    const login = (...extra: string[]) =>
      tool(["auth", "login", "--token", "--site", SITE, "--email", WHO, ...extra], SECRET);

    /** The release before this one, run against the settings this one wrote. */
    const previousBin = process.env["CONFLUENCE_AXI_PREVIOUS_BIN"];
    async function previous(args: string[]): Promise<Ran | undefined> {
      if (!previousBin) return undefined;
      const now = entry;
      entry = [previousBin];
      try {
        return await tool(args);
      } finally {
        entry = now;
      }
    }
    const settingsDir = () => join(env["HOME"] ?? "", ".config", "atlassian-axi");
    const settingsFile = () => join(settingsDir(), "config.json");
    const settings = () =>
      JSON.parse(readFileSync(settingsFile(), "utf8")) as Record<string, unknown>;
    const settingsFolder = () =>
      readdirSync(settingsDir())
        .map((name) => readFileSync(join(settingsDir(), name), "utf8"))
        .join("\n");
    /** What the lab's password store holds for the sign-in, asked directly. */
    const item = () => {
      guard(env);
      return lookup({ ...signInItem(WHO, SITE), env, platform: "linux" });
    };
    const plant = (secret: string) => {
      guard(env);
      return store({
        ...signInItem(WHO, SITE),
        label: signInLabel(WHO, SITE),
        secret,
        env,
        platform: "linux",
      });
    };
    const asked = () => confluence.requests.length;

    it("signs in to the file, moves, reads, refuses a swapped item, moves back, signs out; then a locked store", async () => {
      // 1. Release A: a new sign-in goes to the file, as the previous release
      //    wrote it, and the password store is not touched.
      const signedIn = await login();
      expect(signedIn.status, signedIn.output + signedIn.errors).toBe(0);
      expect(signedIn.output).toContain("token-store: file");
      expect(signedIn.output).toContain("confluence: 200 ok");
      expect(settings()).toEqual({ site: SITE, email: WHO, token: SECRET });
      expect((await item()).state).toBe("missing");
      // ROLLBACK: the previous release reads what a plain sign-in wrote.
      const rolledBack = await previous(["space", "list"]);
      if (rolledBack) {
        expect(rolledBack.status, rolledBack.output + rolledBack.errors).toBe(0);
        expect(rolledBack.output).toContain("LAB");
        expect(confluence.requests.at(-1)?.authorization).toBe(BASIC);
        expect((await previous(["auth", "status"]))?.output).toContain("token: present (config)");
      }
      const offered = await tool(["auth", "status", "--check"]);
      expect(offered.status, offered.output).toBe(0);
      expect(offered.output).toContain(
        "sign_in_store: private file. A password store is available: `confluence-axi auth store keyring` moves the sign-in there",
      );

      // 2. Move it into the password store: the real one, by the real client.
      const moved = await tool(["auth", "store", "keyring"]);
      expect(moved.status, moved.output + moved.errors).toBe(0);
      expect(moved.output.split("\n")[0]).toBe(
        "sign_in: Your sign-in is kept in this computer's password store (GNOME Keyring).",
      );
      expect(moved.output).toContain("moved: yes");
      expect(await item()).toEqual({ state: "found", secrets: [SECRET] });
      expect(settings()).toEqual({
        site: SITE,
        email: WHO,
        store: "keyring",
        secret_fingerprint: PRINT,
      });
      expect(settingsFolder()).not.toContain(SECRET);
      // Nor in plain text in the password store's own file.
      const keyrings = join(env["HOME"] ?? "", ".local/share/keyrings");
      for (const name of readdirSync(keyrings)) {
        expect(readFileSync(join(keyrings, name)).includes(SECRET), name).toBe(false);
      }

      // 3. An everyday command: the token from the password store, and nothing written.
      const before = settingsFolder();
      let sent = asked();
      const listed = await tool(["space", "list"]);
      expect(listed.status, listed.output + listed.errors).toBe(0);
      expect(listed.output).toContain("LAB");
      expect(asked()).toBe(sent + 1);
      expect(confluence.requests.at(-1)?.authorization).toBe(BASIC);
      expect(settingsFolder()).toBe(before);
      // ROLLBACK: the previous release cannot read a sign-in that is in the
      // password store. It says nobody is signed in, and changes nothing.
      const stranded = await previous(["space", "list"]);
      if (stranded) {
        expect(stranded.status).toBe(1);
        expect(stranded.output).toContain("code: AUTH_REQUIRED");
        expect(settingsFolder()).toBe(before);
        expect(await item()).toEqual({ state: "found", secrets: [SECRET] });
      }

      // 4. What auth status and the home view say, without asking the store or Confluence.
      sent = asked();
      const status = await tool(["auth", "status"]);
      expect(status.status, status.output).toBe(0);
      expect(status.output).toContain("status: not checked");
      expect(status.output).toContain("sign_in: password store");
      const home = await tool([]);
      expect(home.output).toContain("sign_in: password store");
      expect(home.output).toContain(`site: ${SITE}`);
      expect(asked()).toBe(sent);
      // And the one check that does ask.
      const checked = await tool(["auth", "status", "--check"]);
      expect(checked.status, checked.output).toBe(0);
      expect(checked.output).toContain("sign_in_store: password store (GNOME Keyring): ok");
      expect(checked.output).toContain("confluence: 200 ok");

      // 5. Another program overwrites the item: refused, and nothing is sent.
      expect(await plant(PLANTED)).toEqual({ state: "stored" });
      sent = asked();
      const swapped = await tool(["space", "list"]);
      expect(swapped.status).toBe(1);
      expect(swapped.output).toContain("code: SIGN_IN_MISMATCH");
      expect((await tool(["auth", "store", "file"])).output).toContain("code: SIGN_IN_MISMATCH");
      expect((await tool(["auth", "status", "--check"])).output).toContain(
        "code: SIGN_IN_MISMATCH",
      );
      expect(asked()).toBe(sent);
      expect(settings()["token"]).toBeUndefined();
      // Put the real one back, as signing in again would.
      await plant(SECRET);

      // 6. Move it back: a file the previous release reads, and the item is gone.
      const back = await tool(["auth", "store", "file"]);
      expect(back.status, back.output + back.errors).toBe(0);
      expect(back.output).toContain("moved: yes");
      expect(settings()).toEqual({
        site: SITE,
        email: WHO,
        token: SECRET,
        store: "file",
        store_reason: "chosen",
        secret_fingerprint: PRINT,
      });
      expect((await item()).state).toBe("missing");
      expect((await tool(["space", "list"])).status).toBe(0);
      // ROLLBACK: after `auth store file`, the previous release reads it again.
      const backAgain = await previous(["space", "list"]);
      if (backAgain) {
        expect(backAgain.status, backAgain.output + backAgain.errors).toBe(0);
        expect(backAgain.output).toContain("LAB");
        expect(confluence.requests.at(-1)?.authorization).toBe(BASIC);
      }

      // 7. Sign out, from the password store: the item and the settings.
      expect((await tool(["auth", "store", "keyring"])).output).toContain("moved: yes");
      const out = await tool(["auth", "logout"]);
      expect(out.status, out.output + out.errors).toBe(0);
      expect(out.output).toContain(
        "the sign-in was removed from this computer's password store",
      );
      expect((await item()).state).toBe("missing");
      expect(existsSync(settingsFile())).toBe(false);
      expect((await tool(["space", "list"])).output).toContain("code: AUTH_REQUIRED");

      // 8. A sign-in straight into the password store, when a person asks for it.
      const direct = await login("--store", "keyring");
      expect(direct.status, direct.output + direct.errors).toBe(0);
      expect(direct.output).toContain(
        "sign_in: Your sign-in is kept in this computer's password store (GNOME Keyring).",
      );
      expect(await item()).toEqual({ state: "found", secrets: [SECRET] });
      expect(settingsFolder()).not.toContain(SECRET);
      expect((await tool(["space", "list"])).status).toBe(0);

      // 9. Last, because nothing here can unlock it again: the same store, locked.
      const dbusSend = findProgram("dbus-send");
      if (dbusSend) {
        guard(env);
        const lockIt = spawnSync(
          dbusSend,
          [
            "--session",
            "--print-reply",
            "--dest=org.freedesktop.secrets",
            "/org/freedesktop/secrets",
            "org.freedesktop.Secret.Service.Lock",
            "array:objpath:/org/freedesktop/secrets/collection/login",
          ],
          { env, encoding: "utf8", timeout: 10_000 },
        );
        expect(lockIt.status, lockIt.stderr).toBe(0);
        expect((await item()).state).toBe("locked");
        sent = asked();
        const lockedOut = await tool(["space", "list"]);
        expect(lockedOut.status).toBe(1);
        expect(lockedOut.output).toContain("code: KEYRING_LOCKED");
        expect(lockedOut.ms).toBeLessThan(4000);
        expect(asked()).toBe(sent);
        expect((await tool(["auth", "status", "--check"])).output).toContain(
          "sign_in_store: password store: locked. Unlock it, then run this again",
        );
        // The home view and auth status do not notice: they never ask.
        expect((await tool([])).output).toContain("sign_in: password store");
        expect((await tool(["auth", "status"])).status).toBe(0);
        // No window was asked for, and none could be: the move stops, and nothing changes.
        const stuck = await tool(["auth", "store", "file"]);
        expect(stuck.output).toContain("code: KEYRING_LOCKED");
        expect(settings()["store"]).toBe("keyring");
        // Signing out still takes the settings, and names the item it could not remove.
        const gone = await tool(["auth", "logout"]);
        expect(gone.output).toContain("could NOT be removed from this computer's password store");
        expect(gone.output).toContain(signInLabel(WHO, SITE));
        expect(existsSync(settingsFile())).toBe(false);
        // A sign-in that asks for the locked store by name is refused, and writes nothing.
        const refused = await login("--store", "keyring");
        expect(refused.status).toBe(1);
        expect(refused.output).toContain("code: KEYRING_LOCKED");
        expect(existsSync(settingsFile())).toBe(false);
      }

      // Through all of it, the token was in nothing the tool said.
      for (const text of everything) {
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain(PLANTED);
      }
    }, 240_000);
  },
);
