/**
 * The shared client of the Reposit keyring standard is a COPY: src/keyring.mjs
 * and src/keyring.d.mts are taken byte for byte from keyring/ in
 * Marl0nL/staff-agent-toolkit and never edited here. A fix is made there, its
 * version goes up, and both files are copied again in a commit that says which
 * version; then the hashes below change with them. That repository's packaging
 * compares the bytes again before a release (`keyring_copy_in_step`).
 *
 * The stand-in bus the unit tests run the client against
 * (src/test-support/fake-bus.mjs) is the same kind of copy, of
 * keyring/test/fake-bus.mjs.
 *
 * Copied from staff-agent-toolkit at c381a1e (the standard, version 1).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KEYRING_SERVICE, TOOL_WORDS, signInItem, signInLabel } from "../src/config.js";
import { VERSION, fingerprint, signInError } from "../src/keyring.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const CLIENT_VERSION = "1.0.1";
const PINNED = {
  "src/keyring.mjs": "0197aca8bd8c6190cf85c882df9f6a34f3405121ed2ff3251e0a79264c05fcf0",
  "src/keyring.d.mts": "4b19ed3429f91dcab25393de041ed7b315a38a73c3203905edb92b622e9ac7ab",
  "src/test-support/fake-bus.mjs":
    "c30e37bce3fbc23cf34e198b1ced8fbe69e73cbd14053c6ef83a2a7c93b2809c",
};

describe("the tool's copy of the shared keyring client", () => {
  it("is byte for byte the pinned version: a local edit fails here", () => {
    for (const [file, sha256] of Object.entries(PINNED)) {
      const bytes = readFileSync(join(root, file));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(sha256);
    }
  });

  it("names its version on its first line, and exports the same one", () => {
    const first = readFileSync(join(root, "src/keyring.mjs"), "utf8").split("\n")[0];
    expect(first).toBe(`// reposit-keyring-client ${CLIENT_VERSION}`);
    expect(VERSION).toBe(CLIENT_VERSION);
    expect(
      readFileSync(join(root, "src/keyring.d.mts"), "utf8").split("\n")[0],
    ).toContain(`reposit-keyring-client ${CLIENT_VERSION}`);
  });

  it("makes the standard's fixed example fingerprint", () => {
    expect(fingerprint("reposit-lab", "a@example.com", "example-token")).toBe(
      "v1:9f617291f6aa07f88c5aabbc6f565c1e87ce52e6591835cc8311596240d61a2b",
    );
  });

  it("the item has the standard's names: the command, the email and the site in lower case, a label a person recognises", () => {
    expect(KEYRING_SERVICE).toBe("confluence-axi");
    expect(signInItem("Priya.Nair@RepositPower.com", "RepositPower.atlassian.net")).toEqual({
      service: "confluence-axi",
      account: "priya.nair@repositpower.com/repositpower.atlassian.net",
    });
    expect(signInLabel("Priya.Nair@RepositPower.com", "repositpower.atlassian.net")).toBe(
      "Reposit agent tools: Confluence sign-in for priya.nair@repositpower.com/repositpower.atlassian.net",
    );
  });

  it("an API token has no hourly pass, so the errors name no `renew`, and every command they name exists", () => {
    expect(TOOL_WORDS.renew).toBe(false);
    const blocked = signInError("KEYRING_BLOCKED", TOOL_WORDS);
    expect(blocked.message).toBe(
      "Your sign-in is kept in this computer's password store, which cannot be reached from inside this sandbox.",
    );
    expect(blocked.help).toBe(
      "Run this command outside the sandbox, or a person signs in again with `confluence-axi auth login --token --store file`.",
    );
    for (const code of [
      "KEYRING_LOCKED",
      "KEYRING_BLOCKED",
      "KEYRING_UNAVAILABLE",
      "KEYRING_FAILED",
      "SIGN_IN_MISSING",
      "SIGN_IN_MISMATCH",
      "SIGN_IN_STORE_UNKNOWN",
    ] as const) {
      const words = signInError(code, TOOL_WORDS, "why");
      expect(`${words.message} ${words.help}`).not.toMatch(/renew|hourly|doctor/);
    }
  });
});
