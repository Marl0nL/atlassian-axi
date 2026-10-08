import { takeBoolFlag, takeValueFlag } from "@atlassian-axi/core";
import {
  type AtlassianCredential,
  type MovedSignIn,
  type OAuthSession,
  type SignInPlace,
  type SignInStoreRow,
  type StoreChoice,
  clearCredential,
  isInteractiveTTY,
  moveSignInToFile,
  moveSignInToPasswordStore,
  normalizeSite,
  readOAuthSession,
  readTokenFromStdin,
  resolveAuthMode,
  resolveCredential,
  resolveOAuthClientSecret,
  sanitizeToken,
  saveCredential,
  saveOAuthSession,
  signInStoreRow,
} from "../config.js";
import { AxiError } from "../errors.js";
import {
  OAUTH_CALLBACK_PORT,
  OAUTH_REDIRECT_URI,
  buildAuthorizeUrl,
  ensureFreshSession,
  exchangeAuthorizationCode,
  fetchAccessibleResources,
  generateState,
  oauthClientId,
  openBrowser,
  startCallbackServer,
  type AccessibleResource,
} from "../oauth.js";
import { promptHidden, promptSelect } from "../prompt.js";
import { renderHelp, renderOutput } from "@atlassian-axi/core";

/**
 * Reposit's own site, used by `auth login --token` when no flag, env var or
 * stored config names one. This fork is Reposit's line; --site overrides it.
 */
export const DEFAULT_SITE = "repositpower.atlassian.net";

export const AUTH_HELP = `usage: confluence-axi auth <login|status|store|logout> [flags]
Manage Confluence auth. Two modes:
  oauth      browser login (the default \`auth login\`) — Bearer tokens against
             api.atlassian.com, auto-refreshed; needs an interactive terminal.
  api-token  \`auth login --token\` — site+email+API token; the token is never an
             argument: at a terminal it is asked for (hidden), otherwise read
             from stdin (agents/CI).

login            OAuth browser login. Opens auth.atlassian.com, catches the
                 http://localhost:8765/callback redirect, stores tokens + cloudId
                 in the 0600 config. --site <site> pre-selects among multiple sites.
                 Requires your own registered 3LO app (no shipped default):
                 ATLASSIAN_AXI_OAUTH_CLIENT_ID (required) + client secret from
                 ATLASSIAN_AXI_OAUTH_CLIENT_SECRET env or prompted once and stored.
                 Always kept in the 0600 config file: Atlassian replaces its
                 secret on every renewal, which only a file can follow.
login --token    API-token login (no browser).
                 --site <site>   falls back to ATLASSIAN_SITE / stored, then ${DEFAULT_SITE}
                 --email <email> account email (falls back to ATLASSIAN_EMAIL / stored)
                 --store <auto|keyring|file>  where the token is kept:
                     auto     (the default) where the settings already say it is
                              kept; for a new sign-in the 0600 config file, or on
                              a Mac the keychain item this tool has always used
                     keyring  this computer's password store. Refused, with
                              nothing saved, when it cannot be used from here
                     file     the 0600 config file, recorded as chosen
                 at a terminal: confluence-axi auth login --token --email e   (asks for the token, hidden)
                 token via stdin: echo -n "<token>" | confluence-axi auth login --token --site s --email e
status           Active mode, where the sign-in is kept, token expiry, and the
                 Confluence REST half. It never asks this computer's password
                 store: with the token kept there it says so and checks nothing.
                 (One exception, as before: a Mac sign-in from before --store
                 existed, in this tool's old keychain item, is still read.)
status --check   The same, and the one check that does ask the password store:
                 the sign_in_store row says whether the sign-in can be read from
                 where it is kept (3 seconds at most, never a password window).
                 Exits 1 when it cannot.
store keyring    Move the API-token sign-in into this computer's password store.
                 The config file then holds no token, only where it is and a
                 fingerprint of it. If the password store cannot be used (none in
                 this session, locked and not unlocked, out of reach), NOTHING
                 changes: the sign-in stays where it is, and this says why.
store file       Move it back into the 0600 config file, then out of the
                 password store. Do this before going back to a version of the
                 tool with no \`auth store\`: it reads only the file.
logout           Clear OAuth tokens + the API-token sign-in, wherever it is kept.

Resolution order: ATLASSIAN_API_TOKEN env > OAuth session > stored API token.
The stored API token is read from the one place the settings say it is kept. A
password store that is locked or out of reach is an error, never a reason to
look somewhere else.

Where the sign-in is kept is not a security boundary: any program running as
you can ask an unlocked password store for it, as it can read the file. What
the password store changes is that the token is not a file to stumble on and is
not in a backup of the settings folder. The cost in this tool: an API token is
needed on every request and there is no hourly pass to fall back on, so with the
token in the password store NO command works inside a Linux agent sandbox, which
cannot reach the store. A person runs \`auth login\` and \`auth store\`, outside
any sandbox: they change the settings folder.
Linux with GNOME Keyring is tested. A Mac's keychain is untested: nobody has run
this there. Windows is not supported.

examples:
  confluence-axi auth login
  echo -n "$TOKEN" | confluence-axi auth login --token --site acme.atlassian.net --email me@acme.com
  confluence-axi auth login --token --email me@acme.com --store keyring
  confluence-axi auth status
  confluence-axi auth status --check
  confluence-axi auth store keyring
  confluence-axi auth store file
  confluence-axi auth logout
`;

const REST_SPACES_PATH = "/wiki/api/v2/spaces?limit=1";
const JIRA_MYSELF_PATH = "/rest/api/3/myself";
const PING_TIMEOUT_MS = 15_000;

export async function authCommand(args: string[]): Promise<string> {
  const action = args[0];
  const rest = args.slice(1);
  // Bare `auth` is a help request, matching the other command routers
  // (help on exit 0, never a validation error).
  if (!action || action === "--help") {
    return AUTH_HELP;
  }
  switch (action) {
    case "login":
      return authLogin(rest);
    case "status":
      return authStatus(rest);
    case "store":
      return authStore(rest);
    case "logout":
      // logout is destructive; a stray/typo'd flag (e.g. `--dry-run`) must be a
      // loud error, never silently accepted while it clears every credential.
      rejectExtraArgs("logout", rest);
      return authLogout();
    default:
      throw new AxiError(
        `Unknown auth action: ${action}`,
        "VALIDATION_ERROR",
        ["Run `confluence-axi auth --help` to see the auth actions: login, status, store, logout"],
      );
  }
}

/** Reject any leftover args after a no-argument auth action (status/logout). */
function rejectExtraArgs(action: string, rest: string[]): void {
  if (rest.length > 0) {
    throw new AxiError(
      `Unexpected arguments after 'auth ${action}': ${rest.join(" ")}`,
      "VALIDATION_ERROR",
      [`\`auth ${action}\` takes no arguments`],
    );
  }
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

async function authLogin(args: string[]): Promise<string> {
  // `auth login --help` must serve help, not start a browser flow.
  if (takeBoolFlag(args, "--help")) {
    return AUTH_HELP;
  }
  if (takeBoolFlag(args, "--token")) {
    return tokenLogin(args);
  }
  return oauthLogin(args);
}

/**
 * Reject whatever `auth login` did not consume. Without this a typo'd
 * `--tokn` is dropped, falls through to the OAuth path and (in an agent/CI
 * shell) surfaces the misleading "needs an interactive terminal" error, and a
 * dropped `--emial` logs in under a stale resolved email - both silent, where
 * `auth status`/`logout` and the shared parseFlags fail loud on exit 2.
 */
function rejectLeftoverLoginArgs(args: string[], validFlags: string[]): void {
  if (args.length === 0) return;
  throw new AxiError(
    `Unexpected arguments after 'auth login': ${args.join(" ")}`,
    "VALIDATION_ERROR",
    [
      `Supported flags: ${validFlags.join(", ")}`,
      "Run `confluence-axi auth --help` for usage",
    ],
  );
}

// --- OAuth (3LO) browser flow -----------------------------------------------

async function oauthLogin(args: string[]): Promise<string> {
  // takeValueFlag, not takeFlag: `--site --email me@acme.com` must name --site
  // as the flag missing its value rather than silently taking "--email" as the
  // site and blaming the leftover email for the failure.
  const siteFlag = normalizeSite(takeValueFlag(args, "--site"));
  const store = takeStoreFlag(args);
  // Before the TTY check, so a mistyped `--tokn` is named as the real problem
  // instead of being reported as a missing interactive terminal.
  rejectLeftoverLoginArgs(args, [
    "--token",
    "--site",
    "--email (with --token)",
    "--store (with --token)",
  ]);
  if (store === "keyring") {
    throw new AxiError(
      "A browser sign-in cannot be kept in this computer's password store: Atlassian replaces its secret on every renewal, which only a file can follow",
      "VALIDATION_ERROR",
      [
        "Run `confluence-axi auth login` to keep the browser sign-in in its private file",
        "Run `confluence-axi auth login --token --store keyring` to sign in with an API token kept in the password store",
      ],
    );
  }

  // Fail fast for agents/CI before any listener/browser/prompt work: a
  // headless invocation must never hang waiting on a browser.
  if (!isInteractiveTTY()) {
    throw new AxiError(
      "OAuth browser login needs an interactive terminal (stdin/stdout is not a TTY)",
      "VALIDATION_ERROR",
      [
        `Agents/CI: echo -n "<token>" | confluence-axi auth login --token --site <site> --email <email>`,
        "Or set ATLASSIAN_SITE / ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN",
      ],
    );
  }

  const clientId = oauthClientId();
  const existingSession = readOAuthSession();
  const resolvedSecret = resolveOAuthClientSecret(existingSession);
  let clientSecret: string;
  let secretSource: "env" | "config" | "prompt";
  if (resolvedSecret) {
    clientSecret = resolvedSecret.secret;
    secretSource = resolvedSecret.source;
  } else {
    process.stderr.write(
      "First OAuth login: the app's client secret is needed once (stored in the 0600 config).\n",
    );
    // Same quote-wrapping paste hazard as the API token — sanitize before use
    // so a mangled secret never reaches the token endpoint or the store.
    clientSecret = sanitizeToken(await promptHidden("OAuth client secret"));
    secretSource = "prompt";
    if (clientSecret === "") {
      throw new AxiError(
        "Empty client secret after stripping quotes — nothing was stored",
        "VALIDATION_ERROR",
        ["Re-run `confluence-axi auth login` and paste the raw secret value"],
      );
    }
  }

  const state = generateState();
  const server = await startCallbackServer({
    port: OAUTH_CALLBACK_PORT,
    expectedState: state,
  });
  let code: string;
  try {
    const authorizeUrl = buildAuthorizeUrl({ clientId, state });
    const opened = await openBrowser(authorizeUrl);
    process.stderr.write(
      `${opened ? "Opened the browser to" : "Could not open a browser — visit"}:\n  ${authorizeUrl}\n` +
        `Waiting for the callback on ${OAUTH_REDIRECT_URI} ...\n`,
    );
    ({ code } = await server.result);
  } finally {
    server.close();
  }

  const tokens = await exchangeAuthorizationCode({ clientId, clientSecret, code });
  const resources = await fetchAccessibleResources(tokens.accessToken);
  const resource = await pickResource(resources, siteFlag);
  const site = normalizeSite(resource.url) as string;

  const session: OAuthSession = {
    clientId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    cloudId: resource.id,
    site,
    scopes: tokens.scopes,
    // Keep the secret out of the store when env supplies it; persist it when
    // it was prompted (first login) or already stored (re-login).
    ...(secretSource === "env" ? {} : { clientSecret }),
  };
  saveOAuthSession(session);

  return renderOutput([
    [
      "auth:",
      `  action: login`,
      `  mode: oauth`,
      `  site: ${site}`,
      `  cloud-id: ${resource.id}`,
      `  token-expires: ${expiryPhrase(session.expiresAt)}`,
      `  secret-source: ${secretSource}`,
    ].join("\n"),
    renderHelp(["Verify end-to-end with `confluence-axi auth status`"]),
  ]);
}

/** Choose the target site among the token's accessible resources. */
async function pickResource(
  resources: AccessibleResource[],
  siteFlag: string | undefined,
): Promise<AccessibleResource> {
  if (resources.length === 0) {
    throw new AxiError(
      "The OAuth token has no accessible Atlassian sites",
      "FORBIDDEN",
      ["Grant the app access to a site at https://id.atlassian.com and re-run `confluence-axi auth login`"],
    );
  }
  if (siteFlag) {
    const match = resources.find((r) => normalizeSite(r.url) === siteFlag);
    if (!match) {
      const available = resources
        .map((r) => normalizeSite(r.url))
        .filter(Boolean)
        .join(", ");
      throw new AxiError(
        `--site ${siteFlag} is not among the token's accessible sites (${available})`,
        "VALIDATION_ERROR",
        ["Re-run with one of the listed sites, or without --site to pick interactively"],
      );
    }
    return match;
  }
  if (resources.length === 1) {
    return resources[0] as AccessibleResource;
  }
  const index = await promptSelect(
    "Multiple Atlassian sites are accessible — pick one:",
    resources.map((r) => `${r.name} (${normalizeSite(r.url)})`),
  );
  return resources[index] as AccessibleResource;
}

// --- API-token flow (agents/CI) ---------------------------------------------

async function tokenLogin(args: string[]): Promise<string> {
  const siteFlag = takeValueFlag(args, "--site");
  const emailFlag = takeValueFlag(args, "--email");
  const store = takeStoreFlag(args);
  // Before stdin is read, so a typo'd flag never consumes the piped token.
  rejectLeftoverLoginArgs(args, ["--token", "--site", "--email", "--store"]);

  // Flags win, then fall back to any already-resolved (env/stored) values so a
  // re-login only needs to supply what changed. The saved token is NOT read:
  // signing in again must work when it cannot be (a locked password store).
  const resolved = await resolveCredential({ storedSecret: false });
  const site = normalizeSite(siteFlag ?? resolved.site ?? DEFAULT_SITE);
  const email = (emailFlag ?? resolved.email)?.trim();

  if (!site || !email) {
    const missing = [!site ? "--site" : null, !email ? "--email" : null].filter(
      Boolean,
    );
    throw new AxiError(
      `Missing required credential fields: ${missing.join(", ")}`,
      "VALIDATION_ERROR",
      [
        `echo -n "<token>" | confluence-axi auth login --token --site <site> --email <email>`,
      ],
    );
  }

  // Never an argument. At a terminal the person pastes it at a hidden prompt,
  // so the whole sign-in is one plain command with no pipe; otherwise stdin.
  const apiToken = await readTokenFromStdin(() =>
    promptHidden(
      "Paste your Atlassian API token and press Enter (it shows as stars)",
      "Run the same command again and paste the token before pressing Enter",
    ),
  );
  const credential: AtlassianCredential = { site, email, apiToken };

  // Validate BEFORE persisting so a mangled paste never overwrites a
  // previously good stored credential.
  const confluenceLine = await validateTokenForLogin(credential);

  // `--store keyring` that cannot be had is refused here, with nothing saved.
  const saved = store
    ? await saveCredential(credential, { store })
    : await saveCredential(credential);

  return renderOutput([
    [
      "auth:",
      `  action: login`,
      `  mode: api-token`,
      `  site: ${site}`,
      `  email: ${email}`,
      `  token-store: ${saved.tokenStore}`,
      ...(saved.sentence ? [`  sign_in: ${saved.sentence}`] : []),
      ...(saved.notes ?? []).map((note) => `  note: ${note}`),
      `  confluence: ${confluenceLine}`,
    ].join("\n"),
    renderHelp([
      saved.tokenStore === "password-store"
        ? "Verify end-to-end with `confluence-axi auth status --check`"
        : "Verify end-to-end with `confluence-axi auth status`",
    ]),
  ]);
}

/** `--store auto|keyring|file`, or undefined when the flag is not given. */
function takeStoreFlag(args: string[]): StoreChoice | undefined {
  const value = takeValueFlag(args, "--store");
  if (value === undefined) return undefined;
  if (value === "auto" || value === "keyring" || value === "file") return value;
  throw new AxiError(
    `--store takes auto, keyring or file, not ${value}`,
    "VALIDATION_ERROR",
    [
      "Run `confluence-axi auth login --token --store keyring` to keep the sign-in in this computer's password store",
      "Run `confluence-axi auth login --token --store file` to keep it in a private file",
    ],
  );
}

/**
 * Login-time credential check with an explicit failure taxonomy. Returns the
 * `confluence:` line for the login output, or throws AUTH_REQUIRED (before
 * anything is persisted) when the token is demonstrably rejected.
 *
 * - Network failure (status 0): the token may be fine — degrade gracefully and
 *   let login proceed with a warning.
 * - Non-200 from Confluence: ambiguous. Confluence v2 answers a rejected
 *   credential with 404 (live-verified), which is also what a Jira-only site
 *   without the Confluence product returns. Disambiguate with a Jira ping —
 *   Jira answers a rejected Basic credential with 401 (live-verified): Jira
 *   200 means the token is good and only Confluence is unavailable (warn);
 *   Jira non-200 means the token itself is rejected (hard fail).
 */
async function validateTokenForLogin(
  credential: AtlassianCredential,
): Promise<string> {
  const rest = await confluencePing(credential);
  if (rest.ok) {
    return "200 ok";
  }
  if (rest.status === 0) {
    return `unreachable (${rest.detail}) — token not verified; check with \`confluence-axi auth status\` once online`;
  }

  const jira = await basicPing(credential, JIRA_MYSELF_PATH);
  if (jira.ok) {
    return `${rest.status} ${rest.detail} — token verified against Jira; the site may not have Confluence (or this account lacks Confluence access)`;
  }
  if (jira.status === 0) {
    return `${rest.status} ${rest.detail} — network dropped before the token could be verified; check with \`confluence-axi auth status\` once online`;
  }
  throw new AxiError(
    `The token was rejected (Confluence ${rest.status}, Jira ${jira.status}) — nothing was saved. Confluence answers rejected credentials with 404/403, so the 404 does not mean the site lacks Confluence.`,
    "AUTH_REQUIRED",
    [
      "Check the token: copy the raw value (no quotes) and re-run `confluence-axi auth login --token`",
      "Check the site host with `confluence-axi auth status`",
    ],
  );
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function authStatus(args: string[]): Promise<string> {
  const check = takeBoolFlag(args, "--check");
  rejectExtraArgs("status", args);
  // `--check` is the one place this command asks the password store. Its row
  // comes first: when the sign-in cannot be read, that is the whole answer.
  const row = check ? await signInStoreRow() : undefined;
  if (row?.counts === "needs-attention") {
    throw new AxiError(
      `auth check failed\n${["auth:", "  status: degraded", `  sign_in_store: ${row.detail}`].join("\n")}`,
      row.code ?? "AUTH_REQUIRED",
      row.next ? [row.next] : [],
    );
  }
  const mode = await resolveAuthMode({ askStore: check });
  if (mode.mode === "none") {
    throw new AxiError(
      `Not authenticated (missing: ${mode.missing.join(", ")})`,
      "AUTH_REQUIRED",
      [
        "Run `confluence-axi auth login` for the OAuth browser flow (interactive terminals)",
        "Or `echo -n \"<token>\" | confluence-axi auth login --token --site <site> --email <email>` (agents/CI)",
      ],
    );
  }
  if (mode.mode === "api-token-unread") {
    // Said from the settings alone. Nothing is read, so nothing is checked.
    return renderOutput([
      [
        "auth:",
        `  status: not checked`,
        `  mode: api-token`,
        `  site: ${mode.site}`,
        `  email: ${mode.email}`,
        `  token: in this computer's password store (not read by this command)`,
        `  sign_in: ${mode.signIn}`,
        `  confluence: not checked`,
      ].join("\n"),
      renderHelp([
        "Run `confluence-axi auth status --check` to read the sign-in from the password store and check Confluence (outside a sandbox)",
      ]),
    ]);
  }
  const kept = keptLines(mode.signIn, row);
  return mode.mode === "oauth"
    ? oauthStatus(mode.oauth, kept)
    : tokenStatus(mode.credential, mode.sources.apiToken ?? "config", kept);
}

/** Where the sign-in is kept: the short form always, the checked row with `--check`. */
function keptLines(
  signIn: SignInPlace | undefined,
  row: SignInStoreRow | undefined,
): string[] {
  return [
    ...(signIn ? [`  sign_in: ${signIn}`] : []),
    ...(row ? [`  sign_in_store: ${row.detail}`] : []),
  ];
}

async function oauthStatus(
  session: OAuthSession,
  kept: string[] = [],
): Promise<string> {
  // Refresh if expired so status exercises the same path real calls use; a
  // failed refresh is the honest "your session is dead" signal.
  let active = session;
  let tokenLine: string;
  let refreshFailed: string | null = null;
  try {
    active = await ensureFreshSession(session);
    tokenLine = `valid (expires ${expiryPhrase(active.expiresAt)})`;
  } catch (error) {
    refreshFailed = error instanceof Error ? error.message : "refresh failed";
    tokenLine = `expired — refresh failed: ${refreshFailed}`;
  }

  const rest = refreshFailed
    ? { ok: false, status: 0, detail: "skipped (token refresh failed)" }
    : await restPing({
        url: `https://api.atlassian.com/ex/confluence/${active.cloudId}${REST_SPACES_PATH}`,
        authorization: `Bearer ${active.accessToken}`,
      });

  const ok = rest.ok;
  const detail = [
    "auth:",
    `  status: ${ok ? "ok" : "degraded"}`,
    `  mode: oauth`,
    `  site: ${active.site}`,
    `  cloud-id: ${active.cloudId}`,
    `  token: ${tokenLine}`,
    ...kept,
    `  confluence: ${rest.ok ? "200 ok" : `${rest.status} ${rest.detail}`}`,
  ].join("\n");

  if (!ok) {
    throw new AxiError(`auth check failed\n${detail}`, "AUTH_REQUIRED", [
      refreshFailed
        ? "Re-run `confluence-axi auth login` to start a fresh OAuth session"
        : "Check the OAuth session — Confluence REST did not return 200",
    ]);
  }
  return renderOutput([detail]);
}

async function tokenStatus(
  credential: AtlassianCredential,
  tokenSource: string,
  kept: string[] = [],
): Promise<string> {
  // Confluence REST half — a cheap authenticated call.
  const rest = await confluencePing(credential);

  const ok = rest.ok;
  const detail = [
    "auth:",
    `  status: ${ok ? "ok" : "degraded"}`,
    `  mode: api-token`,
    `  site: ${credential.site}`,
    `  email: ${credential.email}`,
    `  token: present (${tokenSource})`,
    ...kept,
    `  confluence: ${rest.ok ? "200 ok" : `${rest.status} ${rest.detail}`}`,
  ].join("\n");

  if (!ok) {
    // "Likely invalid" is only fair when Confluence actually rejected the
    // credential; status 0 (network) and 5xx are not the token's fault.
    const restHint =
      rest.status === 401 || rest.status === 403 || rest.status === 404
        ? "The token is likely invalid — Confluence answers rejected credentials with 404/403; copy the raw token (no quotes) and re-run `confluence-axi auth login --token`"
        : "Confluence REST did not return 200 — check the network and the site host, then re-run `confluence-axi auth status`";
    throw new AxiError(`auth check failed\n${detail}`, "AUTH_REQUIRED", [
      restHint,
    ]);
  }

  return renderOutput([detail]);
}

interface PingResult {
  ok: boolean;
  status: number;
  detail: string;
}

function basicAuthorization(credential: AtlassianCredential): string {
  const basic = Buffer.from(
    `${credential.email}:${credential.apiToken}`,
  ).toString("base64");
  return `Basic ${basic}`;
}

/**
 * GET a REST URL with the given Authorization (Basic or Bearer); `status: 0`
 * means the request never got an HTTP response (network failure or timeout).
 * Never throws.
 */
async function restPing(request: {
  url: string;
  authorization: string;
}): Promise<PingResult> {
  try {
    const response = await fetch(request.url, {
      headers: {
        Authorization: request.authorization,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    return {
      ok: response.status === 200,
      status: response.status,
      detail: response.status === 200 ? "ok" : response.statusText,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      detail: error instanceof Error ? error.message : "request failed",
    };
  }
}

/** GET a site-relative REST path with Basic auth (the api-token half). */
function basicPing(
  credential: AtlassianCredential,
  path: string,
): Promise<PingResult> {
  return restPing({
    url: `https://${credential.site}${path}`,
    authorization: basicAuthorization(credential),
  });
}

/** GET /wiki/api/v2/spaces?limit=1 with Basic auth; 200 means the token works. */
function confluencePing(credential: AtlassianCredential): Promise<PingResult> {
  return basicPing(credential, REST_SPACES_PATH);
}

/** Human phrase for a token expiry timestamp (absolute-safe, minute granularity). */
function expiryPhrase(expiresAt: number): string {
  const deltaMs = expiresAt - Date.now();
  if (deltaMs <= 0) {
    return "expired (auto-refreshes on next call)";
  }
  const minutes = Math.max(1, Math.round(deltaMs / 60_000));
  return `in ~${minutes}m`;
}

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

async function authLogout(): Promise<string> {
  const hadOAuth = readOAuthSession() !== null;
  const cleared = await clearCredential();

  return renderOutput([
    [
      "auth:",
      `  action: logout`,
      `  credential: cleared`,
      `  oauth: ${hadOAuth ? "cleared" : "none stored"}`,
      ...(cleared?.item === "removed"
        ? [`  password_store: the sign-in was removed from this computer's password store`]
        : []),
      ...(cleared?.item === "left"
        ? [
            `  password_store: the sign-in could NOT be removed from this computer's password store (${cleared.why}). The settings are gone, so it is not used. To remove it yourself, look for "${cleared.label}"`,
          ]
        : []),
    ].join("\n"),
  ]);
}

// ---------------------------------------------------------------------------
// store keyring | file
// ---------------------------------------------------------------------------

const CHECK = "Run `confluence-axi auth status --check` to check the sign-in where it is kept";

async function authStore(args: string[]): Promise<string> {
  const to = args[0];
  if (args.length !== 1 || (to !== "keyring" && to !== "file")) {
    throw new AxiError(
      to === undefined
        ? "Say where to move the sign-in: keyring (this computer's password store) or file"
        : `\`auth store\` takes keyring or file and nothing else, not ${args.join(" ")}`,
      "VALIDATION_ERROR",
      [
        "Run `confluence-axi auth store keyring` to keep the sign-in in this computer's password store",
        "Run `confluence-axi auth store file` to keep it in a private file",
      ],
    );
  }
  const result =
    to === "keyring" ? await moveSignInToPasswordStore() : await moveSignInToFile();
  return renderOutput([renderMoved(result), renderHelp(moveHelp(to, result))]);
}

/**
 * The sentence comes FIRST: `reposit-agent-tools update` shows a person the
 * first line of what a move step prints, and nothing else.
 */
function renderMoved(result: MovedSignIn): string {
  return [
    `sign_in: ${result.sentence}`,
    `moved: ${result.moved ? "yes" : "no"}`,
    ...(result.why ? [`why: ${result.why}`] : []),
    ...result.notes.map((note) => `note: ${note}`),
  ].join("\n");
}

function moveHelp(to: "keyring" | "file", result: MovedSignIn): string[] {
  if (to === "keyring") {
    if (result.moved) {
      return [CHECK, "Run `confluence-axi auth store file` to move the sign-in back"];
    }
    return result.why
      ? [
          "Run `confluence-axi auth store keyring` again from your desktop session, with the password store unlocked, to move it",
          CHECK,
        ]
      : [CHECK];
  }
  return result.moved
    ? [
        "Run `confluence-axi auth status` to check the sign-in",
        "Run `confluence-axi auth store keyring` to move the sign-in into this computer's password store again",
      ]
    : [CHECK];
}
