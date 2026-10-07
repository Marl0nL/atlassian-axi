import { AxiError } from "axi-sdk-js";
import { renderHelp, renderOutput, takeBoolFlag, takeValueFlag } from "@atlassian-axi/core";
import { acliJson, acliRaw, acliVersion } from "../acli.js";
import { acliNotInstalledError } from "../errors.js";

/**
 * Reposit's own site, used by `auth login --token` when --site does not name
 * one. This fork is Reposit's line; --site overrides it.
 */
export const DEFAULT_SITE = "repositpower.atlassian.net";

export const AUTH_HELP = `usage: jira-axi auth <status|login --token> [flags]
status           Say whether Jira is ready to use: acli is installed and its login
                 answers. Read-only: one cheap Jira read through acli, nothing is
                 changed. Exits 0 only when ready.
login --token    Sign acli in to Jira with an Atlassian API token, asking nothing.
                 --email <email> account email (required)
                 --site <site>   defaults to ${DEFAULT_SITE}
                 token via stdin only, never an argument:
                 echo -n "<token>" | jira-axi auth login --token --email e
                 acli keeps the login in its own store; this tool stores nothing.
                 (acli's browser login, \`acli jira auth login --web\`, always ends
                 in a site menu that needs a terminal: there is no flag for it.)

examples:
  jira-axi auth status
  echo -n "$TOKEN" | jira-axi auth login --token --email me@repositpower.com
`;

export async function authCommand(args: string[]): Promise<string> {
  const action = args[0];
  const rest = args.slice(1);
  // Bare `auth` is a help request, matching the resource command routers.
  if (!action || action === "--help") {
    return AUTH_HELP;
  }
  if (action === "status" && rest.length === 0) {
    return authStatus();
  }
  if (action === "login") {
    return tokenLogin(rest);
  }
  throw new AxiError(`Unknown auth action: ${args.join(" ")}`, "VALIDATION_ERROR", [
    "Run `jira-axi auth status`",
    'Or `echo -n "<token>" | jira-axi auth login --token --email <email>`',
  ]);
}

/**
 * The health check an installer runs. Unlike the no-arg dashboard it has no
 * session-start budget to keep (acli's own 15 s timeout applies), and it
 * answers with an exit code: a slow first call is not "signed out".
 *
 * The probe is a real read rather than `acli jira auth status`, because what a
 * caller wants to know is whether Jira commands work, and a read through the
 * login proves exactly that. An API token that has expired fails it the same
 * way as no login at all.
 */
async function authStatus(): Promise<string> {
  const version = await acliVersion();
  if (version === null) {
    throw acliNotInstalledError();
  }
  try {
    await acliJson(["jira", "project", "list", "--limit", "1", "--json"]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "no answer";
    throw new AxiError(
      `Jira did not answer through acli's login (${reason}). Nobody is signed in, or the API token has expired`,
      "AUTH_REQUIRED",
      [
        'Sign in again with a current API token: `echo -n "<token>" | jira-axi auth login --token --email <email>`',
      ],
    );
  }
  return renderOutput([`auth:\n  status: ok\n  acli: ${version}`]);
}

/**
 * API-token login through `acli jira auth login --site --email --token`,
 * the one acli login that asks nothing. The token goes from our stdin to
 * acli's stdin: never an argument, an environment variable or a file of ours.
 */
async function tokenLogin(args: string[]): Promise<string> {
  if (!takeBoolFlag(args, "--token")) {
    throw new AxiError(
      "Only the API-token login is offered here: pass --token and pipe the token via stdin",
      "VALIDATION_ERROR",
      ['echo -n "<token>" | jira-axi auth login --token --email <email>'],
    );
  }
  const site = bareHost(takeValueFlag(args, "--site") ?? DEFAULT_SITE);
  const email = takeValueFlag(args, "--email")?.trim();
  // Before stdin is read, so a typo'd flag never consumes the piped token.
  if (args.length > 0) {
    throw new AxiError(
      `Unexpected arguments after 'auth login': ${args.join(" ")}`,
      "VALIDATION_ERROR",
      ["Supported flags: --token, --site, --email"],
    );
  }
  if (!email) {
    throw new AxiError("Missing required flag: --email", "VALIDATION_ERROR", [
      'echo -n "<token>" | jira-axi auth login --token --email <email>',
    ]);
  }
  if ((await acliVersion()) === null) {
    throw acliNotInstalledError();
  }

  const token = await tokenFromStdin();
  const result = await acliRaw(
    ["jira", "auth", "login", "--site", site, "--email", email, "--token"],
    token,
  );
  if (result.exitCode !== 0) {
    // acli's own words, minus its decoration and (should it ever echo it) the token.
    const said = `${result.stderr}\n${result.stdout}`
      .split(token)
      .join("<token>")
      .split("\n")
      .map((line) => line.replace(/^[✗x]?\s*Error:\s*/i, "").trim())
      .filter((line) => line !== "")
      .slice(0, 2)
      .join("; ");
    throw new AxiError(
      `acli did not accept the sign-in for ${email} on ${site}${said ? ` (${said})` : ""}. Nothing was changed`,
      "AUTH_REQUIRED",
      [
        "Check the token is the whole value, copied when it was made, and has not expired",
        "Check the email is the Atlassian account's own",
      ],
    );
  }
  return renderOutput([
    ["auth:", "  action: login", "  mode: api-token", `  site: ${site}`, `  email: ${email}`].join("\n"),
    renderHelp(["Verify end-to-end with `jira-axi auth status`"]),
  ]);
}

/** `https://x.atlassian.net/` -> `x.atlassian.net`; anything that is not a bare host is refused. */
function bareHost(site: string): string {
  const bare = site
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  if (!/^[A-Za-z0-9.-]+$/.test(bare)) {
    throw new AxiError(`--site must be a bare host such as ${DEFAULT_SITE}`, "VALIDATION_ERROR");
  }
  return bare;
}

/**
 * Read the token from a pipe. A terminal has nothing piped, so that is an
 * error rather than a wait; a real Atlassian token has no whitespace, so one
 * that does is a mangled paste. One pair of surrounding quotes is stripped.
 */
async function tokenFromStdin(): Promise<string> {
  const pipeIt = ['echo -n "<token>" | jira-axi auth login --token --email <email>'];
  if (process.stdin.isTTY) {
    throw new AxiError(
      "API token is required: pipe it via stdin (never passed as an argument)",
      "VALIDATION_ERROR",
      pipeIt,
    );
  }
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  const trimmed = raw.trim();
  const wrapped = trimmed.match(/^(["'])(.*)\1$/s);
  const token = wrapped ? (wrapped[2] as string).trim() : trimmed;
  // eslint-disable-next-line no-control-regex
  if (token === "" || /[\s\u0000-\u001f\u007f]/.test(token)) {
    throw new AxiError(
      token === ""
        ? "API token is required: pipe it via stdin (never passed as an argument)"
        : "API token contains whitespace or control characters — it looks mangled (quoted, wrapped, or multi-line paste)",
      "VALIDATION_ERROR",
      pipeIt,
    );
  }
  return token;
}
