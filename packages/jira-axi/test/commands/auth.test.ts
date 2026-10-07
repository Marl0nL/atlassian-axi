import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { acliPath, setAcliRunner } from "../../src/acli.js";
import { authCommand } from "../../src/commands/auth.js";
import { includesSeq, makeAcliFake } from "../helpers/acliFake.js";

afterEach(() => setAcliRunner(null));

const isProbe = (args: string[]) =>
  includesSeq(args, ["jira", "project", "list", "--limit", "1", "--json"]);
const isLogin = (args: string[]) => includesSeq(args, ["jira", "auth", "login"]);

/** Run `body` with process.stdin replaced by a pipe carrying `content` (or a terminal). */
async function withStdin<T>(content: string | null, body: () => Promise<T>): Promise<T> {
  const fake = content === null ? new Readable({ read() {} }) : Readable.from([content]);
  Object.defineProperty(fake, "isTTY", { value: content === null });
  const original = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });
  try {
    return await body();
  } finally {
    if (original) Object.defineProperty(process, "stdin", original);
  }
}

describe("auth status", () => {
  it("is ok when a read through acli's login answers, and changes nothing", async () => {
    const fake = makeAcliFake([{ match: isProbe, result: [{ key: "TEAM" }] }]);
    setAcliRunner(fake.runner);
    const out = await authCommand(["status"]);
    expect(out).toContain("status: ok");
    expect(out).toContain("acli: 1.3.22-stable");
    // Only the version and the one read: no login, no mutation.
    expect(fake.calls.map((call) => call.args[0])).toEqual(["--version", "jira"]);
  });

  it("fails with AUTH_REQUIRED when acli is installed but its login does not answer", async () => {
    const fake = makeAcliFake([
      {
        match: isProbe,
        result: { stdout: "", stderr: "✗ Error: unauthorized: use 'acli jira auth login' to authenticate", exitCode: 1 },
      },
    ]);
    setAcliRunner(fake.runner);
    await expect(authCommand(["status"])).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      message: expect.stringContaining("expired"),
    });
  });

  it("fails with ACLI_NOT_INSTALLED, without probing, when acli is missing", async () => {
    const calls: string[][] = [];
    setAcliRunner(async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "ENOENT", exitCode: 127 };
    });
    await expect(authCommand(["status"])).rejects.toMatchObject({ code: "ACLI_NOT_INSTALLED" });
    expect(calls).toEqual([["--version"]]);
  });

  it("serves help for a bare `auth` and rejects an unknown action", async () => {
    expect(await authCommand([])).toContain("usage: jira-axi auth");
    await expect(authCommand(["logout"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("auth login --token", () => {
  it("signs acli in on Reposit's site with the token on stdin only: no menu, no question", async () => {
    const fake = makeAcliFake([{ match: isLogin, result: { stdout: "✓ Authentication successful\n", stderr: "", exitCode: 0 } }]);
    setAcliRunner(fake.runner);

    const out = await withStdin("ATATTtok\n", () =>
      authCommand(["login", "--token", "--email", "sam@repositpower.com"]),
    );

    const login = fake.calls.find((call) => isLogin(call.args));
    expect(login?.args).toEqual([
      "jira", "auth", "login", "--site", "repositpower.atlassian.net", "--email", "sam@repositpower.com", "--token",
    ]);
    // The browser login is the one that ends in a site menu: never asked for.
    expect(login?.args).not.toContain("--web");
    // The token reaches acli on its stdin, and is in no argument and no output.
    expect(login?.stdin).toBe("ATATTtok");
    expect(fake.calls.flatMap((call) => call.args).join(" ")).not.toContain("ATATTtok");
    expect(out).not.toContain("ATATTtok");
    expect(out).toContain("site: repositpower.atlassian.net");
  });

  it("--site overrides the default, and a URL is reduced to its host", async () => {
    const fake = makeAcliFake([{ match: isLogin, result: { stdout: "", stderr: "", exitCode: 0 } }]);
    setAcliRunner(fake.runner);
    await withStdin("tok", () =>
      authCommand(["login", "--token", "--site", "https://acme.atlassian.net/", "--email", "me@acme.com"]),
    );
    expect(fake.calls.find((call) => isLogin(call.args))?.args).toContain("acme.atlassian.net");
  });

  it("says so, without the token, when acli refuses the sign-in", async () => {
    const fake = makeAcliFake([
      { match: isLogin, result: { stdout: "", stderr: "✗ Error: authentication failed for ATATTtok", exitCode: 1 } },
    ]);
    setAcliRunner(fake.runner);
    const failure = await withStdin("ATATTtok", () =>
      authCommand(["login", "--token", "--email", "sam@repositpower.com"]),
    ).catch((error: unknown) => error as { code: string; message: string });
    expect(failure).toMatchObject({ code: "AUTH_REQUIRED" });
    expect((failure as { message: string }).message).toContain("authentication failed");
    expect((failure as { message: string }).message).not.toContain("ATATTtok");
  });

  it("refuses, before acli is asked anything, a missing email, a typo'd flag, a terminal with nothing piped and a mangled token", async () => {
    const fake = makeAcliFake([]);
    setAcliRunner(fake.runner);
    await expect(withStdin("tok", () => authCommand(["login", "--token"]))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      withStdin("tok", () => authCommand(["login", "--token", "--emial", "a@b.c", "--email", "a@b.c"])),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(withStdin("tok", () => authCommand(["login", "--email", "a@b.c"]))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(withStdin(null, () => authCommand(["login", "--token", "--email", "a@b.c"]))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(withStdin("to k", () => authCommand(["login", "--token", "--email", "a@b.c"]))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fake.calls.some((call) => isLogin(call.args))).toBe(false);
  });
});

describe("which acli runs", () => {
  it("prefers the pinned one an installer shipped beside the tool, then the PATH; an env var names one outright", () => {
    // test/fixtures stands in for <tool>/jira-axi/dist/bin: nothing is shipped three levels up.
    expect(acliPath({}, "/nonexistent/jira-axi/dist/bin")).toBe("acli");
    expect(acliPath({ JIRA_AXI_ACLI: "/opt/acli" }, "/nonexistent/jira-axi/dist/bin")).toBe("/opt/acli");
  });
});
