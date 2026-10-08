import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AxiError } from "./errors.js";
import {
  describeStore,
  loadSignIn,
  lookup,
  probe,
  remove as removeItem,
  saveSignIn,
  signInError,
  store as storeItem,
  type FileReason,
  type KeyringState,
  type SignInCode,
  type SignInError,
  type ToolWords,
} from "./keyring.mjs";

/**
 * Unified Atlassian credential — the single source of truth shared by the
 * acli-backed Jira half and the direct-REST Confluence half. Atlassian API
 * tokens are account-scoped, so one triple serves both.
 */
export interface AtlassianCredential {
  site: string;
  email: string;
  apiToken: string;
}

/** Where each resolved field came from, so callers can explain precedence. */
export type CredentialSource =
  | "flag"
  | "env"
  | "config"
  | "keychain"
  | "password-store";

/** Partial resolution — any field may be missing until fully configured. */
export interface ResolvedCredential {
  site?: string;
  email?: string;
  apiToken?: string;
  sources: {
    site?: CredentialSource;
    email?: CredentialSource;
    apiToken?: CredentialSource;
  };
}

/**
 * OAuth 2.0 (3LO) session for the Confluence REST half. Persisted in the 0600
 * config file, always: Atlassian rotates the refresh token on every renewal,
 * and an everyday command may not write a password store (keyring standard,
 * section 8), so this sign-in cannot move there. Always persist the newest.
 */
export interface OAuthSession {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  /** Atlassian cloud id — addresses `https://api.atlassian.com/ex/confluence/{cloudId}`. */
  cloudId: string;
  /** Bare host of the chosen site, e.g. acme.atlassian.net. */
  site: string;
  /** Space-separated granted scopes, as returned by the token endpoint. */
  scopes: string;
  /** Stored on first login when not supplied via ATLASSIAN_AXI_OAUTH_CLIENT_SECRET. */
  clientSecret?: string;
}

interface StoredConfig {
  site?: string;
  email?: string;
  /** The API token, when it is kept in this file. Absent when `store` is "keyring". */
  token?: string;
  oauth?: OAuthSession;
  /**
   * Where the API token is kept, as the keyring standard records it: "keyring"
   * (this computer's password store) or "file" (this file). Absent on a
   * sign-in saved the way every release before the standard saved it: then the
   * token is read as it always was (see `readStoredToken`). Written only by
   * `auth login --token`, `auth store` and `auth logout`.
   */
  store?: string;
  /** Why the file, when `store` is "file": chosen, or what the password store was doing. */
  store_reason?: string;
  /** Which secret the sign-in is (keyring standard, section 4). Never the secret. */
  secret_fingerprint?: string;
}

const CONFIG_DIR_NAME = "atlassian-axi";
const CONFIG_FILE_NAME = "config.json";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Base config directory: `$XDG_CONFIG_HOME` or `~/.config`. */
function configBaseDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg && xdg.trim() !== "") {
    return xdg;
  }
  return join(homedir(), ".config");
}

/** Absolute path to `config.json` (honours XDG for tests/CI). */
export function configPath(): string {
  return join(configBaseDir(), CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

// ---------------------------------------------------------------------------
// This computer's password store (the Reposit keyring standard, release A).
//
// keyring.mjs is the shared client, a byte-for-byte copy that is never edited
// here (test/keyring.test.ts pins it). Every call this tool makes to a password
// store goes through it, so the token is never in an argument list.
//
// This tool signs in with an API token, which is used directly on every
// request: there is no hourly token to cache and so no `renew` (standard,
// section 7). With the token in the password store, every command that needs
// it asks the store, and none works inside a Linux agent sandbox.
// ---------------------------------------------------------------------------

/** The item's `service`: the command name, as the standard says. */
export const KEYRING_SERVICE = "confluence-axi";

/** The commands the standard's errors name. No hourly token, so no `renew`. */
export const TOOL_WORDS: ToolWords = {
  name: "confluence-axi",
  renew: false,
  login: "confluence-axi auth login --token",
  doctor: "confluence-axi auth status --check",
};

/** Tests only: where the client looks for a password store. Never an environment variable. */
export interface KeyringAccess {
  env?: Record<string, string | undefined>;
  platform?: string;
  securityPath?: string;
  limitMs?: number;
  promptMs?: number;
}

let keyringAccess: KeyringAccess = {};

/**
 * Point the shared client somewhere else for tests (a stand-in bus, a stand-in
 * `security`). Pass `undefined` to restore the real session. No environment
 * variable does this: nothing but a flag at sign-in chooses the store.
 */
export function setKeyringAccess(access: KeyringAccess | undefined): void {
  keyringAccess = access ?? {};
}

/** One item per account: the email, a slash, and the site's host (standard, section 3). */
export function signInItem(
  email: string,
  site: string,
): { service: string; account: string } {
  return {
    service: KEYRING_SERVICE,
    account: `${email.trim()}/${site.trim()}`.toLowerCase(),
  };
}

/** What a person sees in their password manager. */
export function signInLabel(email: string, site: string): string {
  return `Reposit agent tools: Confluence sign-in for ${signInItem(email, site).account}`;
}

const CODE_OF: Partial<Record<KeyringState, SignInCode>> = {
  locked: "KEYRING_LOCKED",
  blocked: "KEYRING_BLOCKED",
  "no-bus": "KEYRING_UNAVAILABLE",
  "no-keyring": "KEYRING_UNAVAILABLE",
  failed: "KEYRING_FAILED",
  missing: "SIGN_IN_MISSING",
};

/** The standard's error, in this tool's error shape: code, message, the fix as its help line. */
export function signInFailure(error: SignInError): AxiError {
  return new AxiError(error.message, error.code, [error.help]);
}

/** A password-store call that stopped, as the standard's error. The reason is the client's own text. */
function storeStopped(state: KeyringState, reason?: string): AxiError {
  return signInFailure(
    signInError(CODE_OF[state] ?? "KEYRING_FAILED", TOOL_WORDS, reason ?? ""),
  );
}

// --- The Mac keychain item every release before the standard used -----------

/**
 * Where a sign-in saved before the standard keeps its token on a Mac: one
 * generic password, service `atlassian-axi`, account `api-token`. Release A
 * still reads it and still saves a plain `auth login --token` there, so the
 * release before this one reads everything this one writes by default;
 * `auth store keyring` moves it to the standard's item and removes it.
 */
export interface KeychainBackend {
  get(): Promise<string | null>;
  set(secret: string): Promise<void>;
  remove(): Promise<void>;
}

const LEGACY_ITEM = { service: "atlassian-axi", account: "api-token" };
const LEGACY_LABEL = "atlassian-axi API token";
export const LEGACY_ITEM_WORDS = `service "${LEGACY_ITEM.service}", account "${LEGACY_ITEM.account}"`;

/** Thrown by a keychain write that did not take, carrying the client's state for the sentence. */
class KeychainStopped extends Error {
  constructor(
    readonly state: KeyringState,
    reason?: string,
  ) {
    super(reason ?? "the Mac keychain did not keep the token");
  }
}

/**
 * The same item, through the shared client: the token goes down standard
 * input (it used to be an argument, visible in the process list), and a
 * keychain that is locked or does not answer is an error, where it used to be
 * taken for "nothing there" and the file tried. UNTESTED ON A REAL MAC.
 */
const macKeychain: KeychainBackend = {
  async get() {
    const found = await lookup({ ...LEGACY_ITEM, ...keyringAccess });
    if (found.state === "found") {
      return found.secrets?.[0] || null;
    }
    // Nothing saved there, or a Mac with no `security` command: the file is
    // where such a sign-in is. Anything else is the store failing, said so.
    if (found.state === "missing" || found.state === "no-keyring") {
      return null;
    }
    throw storeStopped(found.state, found.reason);
  },
  async set(secret) {
    const saved = await storeItem({
      ...LEGACY_ITEM,
      label: LEGACY_LABEL,
      secret,
      interactive: true,
      ...keyringAccess,
    });
    if (saved.state !== "stored") {
      throw new KeychainStopped(saved.state, saved.reason);
    }
  },
  async remove() {
    const removed = await removeItem({ ...LEGACY_ITEM, ...keyringAccess });
    if (removed.state !== "removed" && removed.state !== "missing") {
      throw new KeychainStopped(removed.state, removed.reason);
    }
  },
};

let injectedKeychain: KeychainBackend | null | undefined;

/**
 * Override the earlier Mac keychain item for tests. Pass a fake to exercise
 * that path, `null` for a computer that has none, or `undefined` to restore
 * platform auto-detection.
 */
export function setKeychainBackend(backend: KeychainBackend | null | undefined): void {
  injectedKeychain = backend;
}

/** The earlier Mac keychain item, or null on a computer that never had one (Linux). */
function getKeychain(): KeychainBackend | null {
  if (injectedKeychain !== undefined) {
    return injectedKeychain;
  }
  return (keyringAccess.platform ?? process.platform) === "darwin"
    ? macKeychain
    : null;
}

// ---------------------------------------------------------------------------
// Config file I/O
// ---------------------------------------------------------------------------

function readStoredConfig(): StoredConfig {
  const path = configPath();
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    // Type-narrow each field: a wrong-typed value (e.g. {"site": 123} from a
    // hand-edit or partial corruption that still parses) must behave like "not
    // configured", never reach normalizeSite/sanitizeToken and crash every
    // command with a raw `.trim is not a function` TypeError — including
    // `auth login`, the documented recovery path. Mirrors readOAuthSession.
    const raw = parsed as Record<string, unknown>;
    const clean: StoredConfig = {};
    if (typeof raw.site === "string") clean.site = raw.site;
    if (typeof raw.email === "string") clean.email = raw.email;
    if (typeof raw.token === "string") clean.token = raw.token;
    if (typeof raw.store === "string") clean.store = raw.store;
    if (typeof raw.store_reason === "string") {
      clean.store_reason = raw.store_reason;
    }
    if (typeof raw.secret_fingerprint === "string") {
      clean.secret_fingerprint = raw.secret_fingerprint;
    }
    if (raw.oauth && typeof raw.oauth === "object") {
      clean.oauth = raw.oauth as OAuthSession;
    }
    return clean;
  } catch {
    // A corrupt file behaves like "not configured" rather than crashing.
    return {};
  }
}

/**
 * Atomic write (temp file + rename): read-merge-write callers race across
 * processes (the CLI's normal agent usage), and an in-place write torn by a
 * concurrent read would parse-fail into `{}` and silently drop the other
 * credential half on the next merge.
 */
function writeStoredConfig(config: StoredConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: FILE_MODE,
  });
  // writeFileSync only applies mode when creating; enforce 0600 on rewrite too.
  chmodSync(tmpPath, FILE_MODE);
  renameSync(tmpPath, path);
}

// ---------------------------------------------------------------------------
// Resolution (env > the recorded store) + persistence
// ---------------------------------------------------------------------------

function envValue(name: string): string | undefined {
  const raw = process.env[name];
  return raw && raw.trim() !== "" ? raw.trim() : undefined;
}

/**
 * Strip any scheme/trailing slash so we always hold a bare host. Applied at
 * resolution time (not just `auth login`) because ATLASSIAN_SITE=https://...
 * would otherwise reach URL building raw and parse to host "https".
 */
export function normalizeSite(site: string | undefined): string | undefined {
  if (!site) {
    return undefined;
  }
  const bare = site
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  return bare === "" ? undefined : bare;
}

/**
 * Assert a normalized site is a bare `host[:port]` — no userinfo, path, query,
 * or fragment — so building `https://{site}` can never redirect the Basic-auth
 * credential to an attacker-controlled host. Without this, a site of
 * `victim.atlassian.net@evil.com` parses to origin host `evil.com` and the
 * account-scoped API token is POSTed to the attacker (the OAuth transport is
 * already pinned to its cloudId; the API-token transport had no equivalent
 * guard). Throws VALIDATION_ERROR on anything that is not a bare host.
 *
 * Called at request-build time (`baseUrl`, inside a command handler's
 * try/catch) — deliberately NOT from `normalizeSite`, which the SDK runs inside
 * `resolveContext` outside any catch (a throw there is an unhandled rejection).
 */
export function assertBareHostSite(site: string): void {
  const invalid = (): AxiError =>
    new AxiError(
      `Invalid site: ${JSON.stringify(site)} — expected a bare host like acme.atlassian.net`,
      "VALIDATION_ERROR",
      [
        "Pass only the host (no scheme, path, credentials, or query)",
        "Run `confluence-axi auth status` to see the configured site",
      ],
    );
  let url: URL;
  try {
    url = new URL(`https://${site}`);
  } catch {
    throw invalid();
  }
  const bareHost =
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    url.host === site.toLowerCase();
  if (!bareHost) {
    throw invalid();
  }
}

/**
 * Resolve the credential with env winning over persisted state:
 *   site   : ATLASSIAN_SITE       > config.site
 *   email  : ATLASSIAN_EMAIL      > config.email
 *   token  : ATLASSIAN_API_TOKEN  > the store the settings recorded, and no other
 */
/**
 * Per-invocation site override from the `--site` flag. Highest precedence in
 * credential resolution (flag > env > stored) — without this the flag only
 * decorated help suggestions while requests silently hit the stored site
 * (found live 2026-07-19 querying one site with another site's credential).
 */
let siteOverride: string | undefined;

export function setSiteOverride(site: string | undefined): void {
  siteOverride = normalizeSite(site);
}

/**
 * The site the user EXPLICITLY asked for this invocation (--site flag or
 * ATLASSIAN_SITE env), or undefined when running against the stored default.
 * Used by transports that cannot re-target (OAuth cloudId, acli login) to
 * refuse a mismatch instead of silently querying the wrong instance.
 */
export function requestedSite(): string | undefined {
  return siteOverride ?? normalizeSite(envValue("ATLASSIAN_SITE"));
}

/** The site persisted in the config file, ignoring flag/env overrides. */
export function storedSite(): string | undefined {
  return normalizeSite(readStoredConfig().site);
}

/**
 * THE ONE PLACE THE STORED API TOKEN IS READ. From the store the settings
 * recorded and no other: a store that is locked, out of reach, empty or
 * holding something else stops the command with the standard's error, and
 * nothing else is tried.
 *
 * A sign-in with no `store` was saved the way every release before the
 * standard saved it, and is read as it always was: the earlier Mac keychain
 * item where there is one (a Mac), otherwise the file's `token`.
 */
async function readStoredToken(
  stored: StoredConfig,
): Promise<{ apiToken: string; source: CredentialSource } | undefined> {
  if (stored.store === undefined) {
    // Every read path goes through sanitizeToken so a quote-wrapped value in
    // the keychain or config file (the original confl404 corruption) is
    // repaired at resolution time, not just at `auth login`.
    const keychain = getKeychain();
    const fromKeychain = sanitizeToken((keychain ? await keychain.get() : null) ?? "");
    if (fromKeychain) {
      return { apiToken: fromKeychain, source: "keychain" };
    }
    const fromFile = sanitizeToken(stored.token ?? "");
    return fromFile ? { apiToken: fromFile, source: "config" } : undefined;
  }
  const got = await loadRecorded(stored);
  if (!got.ok) {
    throw signInFailure(got);
  }
  return {
    apiToken: got.secret,
    source: stored.store === "keyring" ? "password-store" : "config",
  };
}

/** `loadSignIn` for a sign-in whose store is recorded: the fingerprint checked, never a window. */
async function loadRecorded(
  stored: StoredConfig,
): Promise<{ ok: true; secret: string } | SignInError> {
  const missing: SignInError = {
    ...signInError("SIGN_IN_MISSING", TOOL_WORDS),
    state: "missing",
  };
  if (!stored.email || !stored.site) {
    // The settings name a store but not whose sign-in it is: there is no item to ask for.
    return missing;
  }
  try {
    return await loadSignIn({
      ...signInItem(stored.email, stored.site),
      ...(stored.store !== undefined ? { store: stored.store } : {}),
      ...(stored.secret_fingerprint
        ? { fingerprint: stored.secret_fingerprint }
        : {}),
      ...(stored.token ? { fileSecret: stored.token } : {}),
      tool: TOOL_WORDS,
      ...keyringAccess,
    });
  } catch (error) {
    // The client names no item for an address of this shape, so none was ever saved.
    if (error instanceof TypeError) return missing;
    throw error;
  }
}

export interface ResolveOptions {
  /**
   * false: resolve site, email and an environment token only, and never read
   * the stored token. For sign-in itself, which must work when the saved
   * sign-in cannot be read (that is often why a person is signing in again).
   */
  storedSecret?: boolean;
}

export async function resolveCredential(
  options: ResolveOptions = {},
): Promise<ResolvedCredential> {
  const stored = readStoredConfig();
  const resolved: ResolvedCredential = { sources: {} };

  const envSite = normalizeSite(envValue("ATLASSIAN_SITE"));
  const storedSite = normalizeSite(stored.site);
  if (siteOverride) {
    resolved.site = siteOverride;
    resolved.sources.site = "flag";
  } else if (envSite) {
    resolved.site = envSite;
    resolved.sources.site = "env";
  } else if (storedSite) {
    resolved.site = storedSite;
    resolved.sources.site = "config";
  }

  const envEmail = envValue("ATLASSIAN_EMAIL");
  if (envEmail) {
    resolved.email = envEmail;
    resolved.sources.email = "env";
  } else if (stored.email) {
    resolved.email = stored.email;
    resolved.sources.email = "config";
  }

  // The environment is a third, stated source (CI): it wins, it is never
  // written anywhere, and with it set no store is asked at all.
  const envToken = sanitizeToken(envValue("ATLASSIAN_API_TOKEN") ?? "");
  if (envToken) {
    resolved.apiToken = envToken;
    resolved.sources.apiToken = "env";
  } else if (options.storedSecret !== false) {
    const read = await readStoredToken(stored);
    if (read) {
      resolved.apiToken = read.apiToken;
      resolved.sources.apiToken = read.source;
    }
  }

  return resolved;
}

/** Throw a friendly AUTH_REQUIRED error naming the missing pieces. */
export function authRequiredError(missing: string[]): AxiError {
  return new AxiError(
    `Not authenticated (missing: ${missing.join(", ")})`,
    "AUTH_REQUIRED",
    [
      "Run `confluence-axi auth login` for the OAuth browser flow (interactive terminals)",
      "Or run `confluence-axi auth login --token --site <site> --email <email>` and pipe your API token via stdin",
      "Or set ATLASSIAN_SITE / ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN",
    ],
  );
}

/** Resolve a complete credential or throw AUTH_REQUIRED listing what's absent. */
export async function requireCredential(): Promise<AtlassianCredential> {
  const resolved = await resolveCredential();
  const missing: string[] = [];
  if (!resolved.site) missing.push("site");
  if (!resolved.email) missing.push("email");
  if (!resolved.apiToken) missing.push("apiToken");
  if (missing.length > 0) {
    throw authRequiredError(missing);
  }
  return {
    site: resolved.site as string,
    email: resolved.email as string,
    apiToken: resolved.apiToken as string,
  };
}

// ---------------------------------------------------------------------------
// Saving, moving and removing the API-token sign-in
// ---------------------------------------------------------------------------

/** What `--store` takes. */
export type StoreChoice = "auto" | "keyring" | "file";

export interface SavedCredential {
  /** `keychain` is the earlier Mac item; `password-store` is the standard's item. */
  tokenStore: "keychain" | "file" | "password-store";
  /** One plain sentence saying where the sign-in is kept. */
  sentence: string;
  /** Anything a person should know that is not an error (a copy that could not be removed). */
  notes: string[];
}

const KEPT_IN_EARLIER_ITEM =
  "Your sign-in is kept in this computer's password store (the Mac keychain, under this tool's earlier item name).";

/** The settings without anything that says where the API token is, or the token itself. */
function withoutSignIn(stored: StoredConfig): StoredConfig {
  const rest = { ...stored };
  delete rest.token;
  delete rest.store;
  delete rest.store_reason;
  delete rest.secret_fingerprint;
  return rest;
}

/**
 * Stop before a password-store item is written when the settings folder
 * cannot be: an item the settings do not point at would be a second copy of
 * the token that nothing reads. `again` is the command to run, as written.
 */
function requireWritableSettings(again: string): void {
  let folder = dirname(configPath());
  while (!existsSync(folder) && dirname(folder) !== folder) {
    folder = dirname(folder);
  }
  try {
    accessSync(folder, constants.W_OK);
  } catch {
    throw new AxiError(
      `The settings folder cannot be written from here (${dirname(configPath())}), so nothing changed. An agent sandbox keeps it read-only`,
      "SETTINGS_NOT_WRITABLE",
      [`Run \`${again}\` outside the sandbox (a person does this)`],
    );
  }
}

/** Removes the standard's item. Never a window. `label` is for telling a person which one stayed. */
async function removeSignInItem(
  email: string,
  site: string,
): Promise<{ state: KeyringState; reason?: string; label: string }> {
  const label = signInLabel(email, site);
  try {
    const removed = await removeItem({
      ...signInItem(email, site),
      ...keyringAccess,
    });
    return { ...removed, label };
  } catch (error) {
    // No item can carry this address, so there is none to remove.
    if (error instanceof TypeError) return { state: "missing", label };
    throw error;
  }
}

const leftBehind = (label: string, reason?: string): string =>
  `a copy in this computer's password store could not be removed (${reason ?? "it did not answer"}). It is not used. To remove it yourself, look for "${label}"`;

/** After a sign-in has left the earlier Mac item: remove it, and say so if it stays. */
async function dropEarlierItem(notes: string[]): Promise<void> {
  const keychain = getKeychain();
  if (!keychain) return;
  try {
    await keychain.remove();
  } catch {
    notes.push(
      `the earlier Mac keychain item could not be removed. It is not used. To remove it yourself, look for ${LEGACY_ITEM_WORDS}`,
    );
  }
}

/**
 * Persist an API-token sign-in.
 *
 * RELEASE A: with no `store` (or `auto`) the sign-in goes where the settings
 * already say it is kept, and for a new person exactly where the release
 * before this one put it: the 0600 config file, or on a Mac the earlier
 * keychain item. Nothing is recorded for that, so the previous release reads
 * what this one wrote. `keyring` and `file` are the standard's two stores,
 * recorded with the fingerprint; `keyring` that cannot be had is refused and
 * writes nothing.
 */
export async function saveCredential(
  credential: AtlassianCredential,
  options: { store?: StoreChoice } = {},
): Promise<SavedCredential> {
  // Merge with the stored config so an API-token login never clobbers an
  // existing OAuth session (and vice versa — see saveOAuthSession).
  const stored = readStoredConfig();
  const recorded =
    stored.store === "keyring" || stored.store === "file" ? stored.store : undefined;
  const want =
    options.store && options.store !== "auto" ? options.store : recorded;
  if (want === "keyring") return saveToPasswordStore(credential, stored);
  if (want === "file") return saveToRecordedFile(credential, stored, "chosen");
  return saveAsBefore(credential, stored);
}

/** Where every release before the standard put a sign-in. Nothing about the store is recorded. */
async function saveAsBefore(
  credential: AtlassianCredential,
  stored: StoredConfig,
): Promise<SavedCredential> {
  const base = withoutSignIn(stored);
  const keychain = getKeychain();
  if (keychain) {
    let why: FileReason = "failed";
    try {
      await keychain.set(credential.apiToken);
      // The token lives in the keychain now; a stale file token would shadow
      // rotations, so it is not written back.
      writeStoredConfig({ ...base, site: credential.site, email: credential.email });
      return { tokenStore: "keychain", sentence: KEPT_IN_EARLIER_ITEM, notes: [] };
    } catch (error) {
      if (error instanceof KeychainStopped && error.state in WHY_FILE) {
        why = error.state as FileReason;
      }
    }
    // The keychain did not keep it. The file does, and that is SAID and
    // RECORDED: an item the failed write left behind is then never read.
    return saveToRecordedFile(credential, stored, why);
  }
  writeStoredConfig({
    ...base,
    site: credential.site,
    email: credential.email,
    token: credential.apiToken,
  });
  return { tokenStore: "file", sentence: describeStore({ store: "file" }), notes: [] };
}

/** The reasons the standard has a sentence for. */
const WHY_FILE: Record<FileReason, true> = {
  chosen: true,
  "no-bus": true,
  "no-keyring": true,
  locked: true,
  blocked: true,
  failed: true,
};

/** The file, as one of the standard's two stores: recorded, with its reason and the fingerprint. */
async function saveToRecordedFile(
  credential: AtlassianCredential,
  stored: StoredConfig,
  reason: FileReason,
): Promise<SavedCredential> {
  const base = withoutSignIn(stored);
  const notes: string[] = [];
  let print: string | undefined;
  try {
    const saved = await saveSignIn({
      ...signInItem(credential.email, credential.site),
      label: signInLabel(credential.email, credential.site),
      secret: credential.apiToken,
      want: "file",
      tool: TOOL_WORDS,
      ...keyringAccess,
    });
    if (!("ok" in saved)) print = saved.fingerprint;
  } catch (error) {
    // The standard has no item, and so no fingerprint, for an address or a
    // token of this shape. It is kept in the file as it was before the
    // standard, which is where it would have gone anyway.
    if (!(error instanceof TypeError)) throw error;
  }
  writeStoredConfig({
    ...base,
    site: credential.site,
    email: credential.email,
    token: credential.apiToken,
    ...(print
      ? { store: "file", store_reason: reason, secret_fingerprint: print }
      : {}),
  });
  // With the file as the store, no item may stay behind: not the one an
  // earlier sign-in kept in the password store, nor the earlier Mac one.
  for (const item of itemsOf(stored, credential)) {
    const removed = await removeSignInItem(item.email, item.site);
    if (removed.state === "removed") {
      notes.push("the copy in this computer's password store was removed");
    } else if (stored.store === "keyring" && removed.state !== "missing") {
      notes.push(leftBehind(removed.label, removed.reason));
    }
  }
  await dropEarlierItem(notes);
  return {
    tokenStore: "file",
    sentence: describeStore(print ? { store: "file", reason } : { store: "file" }),
    notes,
  };
}

/** The accounts whose item may exist: the one being signed in, and the one the settings had. */
function itemsOf(
  stored: StoredConfig,
  credential?: AtlassianCredential,
): Array<{ email: string; site: string }> {
  const items = new Map<string, { email: string; site: string }>();
  for (const one of [
    credential ? { email: credential.email, site: credential.site } : undefined,
    stored.email && stored.site
      ? { email: stored.email, site: stored.site }
      : undefined,
  ]) {
    if (one) items.set(signInItem(one.email, one.site).account, one);
  }
  return [...items.values()];
}

/** This computer's password store, asked for by name: proven before anything is recorded, or refused. */
async function saveToPasswordStore(
  credential: AtlassianCredential,
  stored: StoredConfig,
): Promise<SavedCredential> {
  requireWritableSettings("confluence-axi auth login --token --store keyring");
  const item = signInItem(credential.email, credential.site);
  let saved: Awaited<ReturnType<typeof saveSignIn>>;
  try {
    // A person is signing in, so a locked store may ask them to unlock it.
    saved = await saveSignIn({
      ...item,
      label: signInLabel(credential.email, credential.site),
      secret: credential.apiToken,
      want: "keyring",
      interactive: true,
      tool: TOOL_WORDS,
      ...keyringAccess,
    });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw notOfAShape("Nothing was saved");
  }
  if ("ok" in saved) {
    // Refused: nothing is recorded, and an earlier sign-in is left as it was.
    throw signInFailure(saved);
  }
  if (saved.store !== "keyring") {
    // The client answers the password store or a refusal when asked for it by name.
    throw storeStopped("failed", "the sign-in was not kept");
  }
  writeStoredConfig({
    ...withoutSignIn(stored),
    site: credential.site,
    email: credential.email,
    store: "keyring",
    secret_fingerprint: saved.fingerprint,
  });
  const notes: string[] = [];
  // Another account's item, if this sign-in replaced one.
  for (const other of itemsOf(stored)) {
    if (signInItem(other.email, other.site).account === item.account) continue;
    if (stored.store !== "keyring") continue;
    const removed = await removeSignInItem(other.email, other.site);
    if (removed.state !== "removed" && removed.state !== "missing") {
      notes.push(leftBehind(removed.label, removed.reason));
    }
  }
  await dropEarlierItem(notes);
  return { tokenStore: "password-store", sentence: describeStore(saved), notes };
}

function notOfAShape(ending: string): AxiError {
  return new AxiError(
    `This sign-in cannot be kept in this computer's password store: its email address or its token is not of a shape the store's item takes. ${ending}`,
    "VALIDATION_ERROR",
    ["Run `confluence-axi auth login --token --store file` to keep it in a private file"],
  );
}

// --- auth store keyring | file ----------------------------------------------

export interface MovedSignIn {
  moved: boolean;
  /** One plain sentence saying where the sign-in is now. Printed first. */
  sentence: string;
  /** Why it was not moved, when the password store could not be used. */
  why?: string;
  notes: string[];
}

function assertKnownStore(stored: StoredConfig): void {
  if (
    stored.store !== undefined &&
    stored.store !== "file" &&
    stored.store !== "keyring"
  ) {
    throw signInFailure(signInError("SIGN_IN_STORE_UNKNOWN", TOOL_WORDS));
  }
}

function nothingToMove(stored: StoredConfig): MovedSignIn {
  if (stored.oauth) {
    // Atlassian replaces the browser sign-in's secret on every renewal, which
    // an everyday command would then have to write to the password store.
    return {
      moved: false,
      sentence:
        "Your browser sign-in is kept in a private file on this computer, and stays there: Atlassian replaces its secret on every renewal, which only a file can follow.",
      notes: [],
    };
  }
  throw new AxiError(
    "There is no API-token sign-in on this computer to move",
    "AUTH_REQUIRED",
    ["Run `confluence-axi auth login --token` to sign in (a person does this: it asks for the API token)"],
  );
}

/** Where a sign-in is kept, said from the settings alone. */
function keptSentence(stored: StoredConfig, inEarlierItem: boolean): string {
  if (stored.store === "keyring") return describeStore({ store: "keyring" });
  if (inEarlierItem) return KEPT_IN_EARLIER_ITEM;
  return describeStore({
    store: "file",
    ...(stored.store_reason ? { reason: stored.store_reason } : {}),
  });
}

/**
 * `auth store keyring`. THE ORDER IS THE POINT: the item is written, read back
 * and compared BEFORE the settings file changes, and that file changes in one
 * rename. A run killed between the two leaves the token in both places, which
 * is harmless, and running the command again finishes the job.
 */
export async function moveSignInToPasswordStore(): Promise<MovedSignIn> {
  const stored = readStoredConfig();
  assertKnownStore(stored);
  if (stored.store === "keyring") {
    // Already recorded there. Said only once it has been read and matches.
    const got = await loadRecorded(stored);
    if (!got.ok) throw signInFailure(got);
    return {
      moved: false,
      sentence: `${describeStore({ store: "keyring" })} It was already there.`,
      notes: [],
    };
  }
  // 1. The saved sign-in, from where it is now.
  let secret: string | undefined;
  let inEarlierItem = false;
  if (stored.store === "file") {
    const got = await loadRecorded(stored);
    if (!got.ok) throw signInFailure(got);
    secret = got.secret;
  } else {
    const keychain = getKeychain();
    const earlier = sanitizeToken((keychain ? await keychain.get() : null) ?? "");
    inEarlierItem = earlier !== "";
    secret = earlier || sanitizeToken(stored.token ?? "") || undefined;
  }
  if (!secret || !stored.email || !stored.site) return nothingToMove(stored);
  requireWritableSettings("confluence-axi auth store keyring");
  // 2. The item: written, read back and compared. A person is here, so a
  //    locked password store may ask them to unlock it.
  let saved: Awaited<ReturnType<typeof saveSignIn>>;
  try {
    saved = await saveSignIn({
      ...signInItem(stored.email, stored.site),
      label: signInLabel(stored.email, stored.site),
      secret,
      want: "keyring",
      interactive: true,
      tool: TOOL_WORDS,
      ...keyringAccess,
    });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw notOfAShape("Nothing changed: it is still where it was");
  }
  if ("ok" in saved || saved.store !== "keyring") {
    // Not usable: nothing changed, and that is not a failure. The tool keeps
    // working from where the sign-in is.
    return {
      moved: false,
      sentence: `${keptSentence(stored, inEarlierItem)} It was not moved: this computer's password store could not be used${"ok" in saved ? ` (${saved.code})` : ""}.`,
      ...("ok" in saved ? { why: saved.message } : {}),
      notes: [],
    };
  }
  // 3. Only now the settings file, in one rename: the token out, the store
  //    and the fingerprint in.
  writeStoredConfig({
    ...withoutSignIn(stored),
    store: "keyring",
    secret_fingerprint: saved.fingerprint,
  });
  // 4. The earlier Mac item, once the new one is proven and recorded.
  const notes: string[] = [];
  await dropEarlierItem(notes);
  return { moved: true, sentence: describeStore(saved), notes };
}

/**
 * `auth store file`, the mirror: the settings file gets the token back first
 * (a file the release before this one reads), and only then is the item
 * removed.
 */
export async function moveSignInToFile(): Promise<MovedSignIn> {
  const stored = readStoredConfig();
  assertKnownStore(stored);
  const notes: string[] = [];
  if (stored.store === "keyring") {
    requireWritableSettings("confluence-axi auth store file");
    // 1. From the password store, fingerprint checked. Locked, out of reach
    //    or not the one saved: the standard's error, and nothing changes.
    const got = await loadRecorded(stored);
    if (!got.ok) throw signInFailure(got);
    // 2. The settings file first, in one rename.
    writeStoredConfig({
      ...stored,
      token: got.secret,
      store: "file",
      store_reason: "chosen",
    });
    // 3. Only then the item.
    for (const item of itemsOf(stored)) {
      const removed = await removeSignInItem(item.email, item.site);
      if (removed.state !== "removed" && removed.state !== "missing") {
        notes.push(leftBehind(removed.label, removed.reason));
      }
    }
    return {
      moved: true,
      sentence: describeStore({ store: "file", reason: "chosen" }),
      notes,
    };
  }
  if (stored.store === undefined) {
    // A sign-in from before the standard that is in the earlier Mac item.
    const keychain = getKeychain();
    const earlier = sanitizeToken((keychain ? await keychain.get() : null) ?? "");
    if (earlier && stored.email && stored.site) {
      requireWritableSettings("confluence-axi auth store file");
      const saved = await saveToRecordedFile(
        { site: stored.site, email: stored.email, apiToken: earlier },
        stored,
        "chosen",
      );
      return { moved: true, sentence: saved.sentence, notes: saved.notes };
    }
  }
  if (!stored.token) return nothingToMove(stored);
  // Already in the file. A move that was interrupted may have left the item: it goes now.
  for (const item of itemsOf(stored)) {
    const removed = await removeSignInItem(item.email, item.site);
    if (removed.state === "removed") {
      notes.push("a copy left in this computer's password store was removed");
    }
  }
  return {
    moved: false,
    sentence: `${keptSentence(stored, false)} It was already there.`,
    notes,
  };
}

// --- Where the sign-in is kept, for `auth status` and the home view -------------

/** The short form `auth status` and the home view carry. From the settings alone: no store is asked. */
export type SignInPlace =
  | "password store"
  | "private file"
  | "environment (ATLASSIAN_API_TOKEN, saved nowhere)";

function placeOf(stored: StoredConfig): SignInPlace {
  if (stored.store === "keyring") return "password store";
  // Before the standard, on a Mac with no token in the file: the earlier keychain item.
  if (stored.store === undefined && !stored.token && getKeychain()) {
    return "password store";
  }
  return "private file";
}

export interface SignInStoreRow {
  /** needs-attention makes `auth status --check` fail. */
  counts: "ok" | "information" | "needs-attention";
  detail: string;
  /** The standard's code, when the store stopped. */
  code?: string;
  /** What to do about it. */
  next?: string;
}

/** `private file, because ...`: the standard's own words for a reason. */
function fileWords(reason: string | undefined): string {
  const sentence = describeStore({ store: "file", ...(reason ? { reason } : {}) });
  return `private file, ${sentence.slice(sentence.indexOf(", ") + 2).replace(/\.$/, "")}`;
}

/**
 * The `sign_in_store` row of the standard (section 9), for `auth status
 * --check`: the one place besides sign-in, sign-out and the two moves that
 * asks the password store whether the sign-in is there. Three seconds at
 * most, never a window, and the token is dropped as soon as its fingerprint
 * has been checked: this returns words only.
 */
export async function signInStoreRow(): Promise<SignInStoreRow> {
  if (sanitizeToken(envValue("ATLASSIAN_API_TOKEN") ?? "")) {
    return {
      counts: "information",
      detail:
        "environment variable ATLASSIAN_API_TOKEN: used as it is, and saved nowhere on this computer",
    };
  }
  const stored = readStoredConfig();
  if (readOAuthSession()) {
    return {
      counts: "information",
      detail:
        "private file, as chosen at sign-in (a browser sign-in is always kept there: Atlassian replaces its secret on every renewal)",
    };
  }
  const stopped = (error: SignInError, detail: string): SignInStoreRow => ({
    counts: "needs-attention",
    detail,
    code: error.code,
    next: error.help,
  });
  if (
    stored.store !== undefined &&
    stored.store !== "file" &&
    stored.store !== "keyring"
  ) {
    const error = signInError("SIGN_IN_STORE_UNKNOWN", TOOL_WORDS);
    return stopped(error, error.message);
  }
  if (stored.store === "keyring") {
    const store = await probe({ ...keyringAccess });
    const got = await loadRecorded(stored);
    if (got.ok) {
      return {
        counts: "ok",
        detail: `password store${store.provider ? ` (${store.provider})` : ""}: ok`,
      };
    }
    switch (got.state) {
      case "locked":
        return stopped(got, "password store: locked. Unlock it, then run this again");
      case "blocked":
        // No hourly pass in this tool: nothing to fall back on inside a sandbox.
        return stopped(
          got,
          "password store: cannot be reached from inside a sandbox. Run this command outside the sandbox",
        );
      case "missing":
      case "mismatch":
        return stopped(
          got,
          `password store: the saved sign-in is not there. A person runs \`${TOOL_WORDS.login}\``,
        );
      default:
        return stopped(got, `password store: ${got.message} ${got.help}`);
    }
  }
  if (stored.store === undefined) {
    const keychain = getKeychain();
    if (keychain) {
      let earlier: string;
      try {
        earlier = sanitizeToken((await keychain.get()) ?? "");
      } catch (error) {
        if (!(error instanceof AxiError)) throw error;
        return {
          counts: "needs-attention",
          detail: `password store (the Mac keychain, under this tool's earlier item name): ${error.message}`,
          code: error.code,
          ...(error.suggestions[0] ? { next: error.suggestions[0] } : {}),
        };
      }
      if (earlier) {
        return {
          counts: "ok",
          detail:
            "password store (the Mac keychain, under this tool's earlier item name): ok. `confluence-axi auth store keyring` moves the sign-in to the item every Reposit agent tool uses",
        };
      }
    }
    if (!sanitizeToken(stored.token ?? "")) {
      return { counts: "information", detail: "no sign-in is saved" };
    }
  } else {
    const got = await loadRecorded(stored);
    if (!got.ok) {
      return stopped(
        got,
        `private file: ${got.message} A person runs \`${TOOL_WORDS.login}\``,
      );
    }
    if (stored.store_reason && stored.store_reason !== "chosen") {
      return { counts: "information", detail: fileWords(stored.store_reason) };
    }
  }
  const store = await probe({ ...keyringAccess });
  if (store.state === "usable") {
    return {
      counts: "information",
      detail:
        "private file. A password store is available: `confluence-axi auth store keyring` moves the sign-in there (after which no command of this tool works inside an agent sandbox)",
    };
  }
  return { counts: "information", detail: fileWords(stored.store_reason) };
}

// ---------------------------------------------------------------------------
// OAuth session persistence + auth-mode resolution
// ---------------------------------------------------------------------------

/**
 * Read the persisted OAuth session, or null when absent/malformed. A session
 * missing any required field is treated as "not logged in" rather than
 * crashing every command — `auth login` rewrites it whole.
 */
export function readOAuthSession(): OAuthSession | null {
  const oauth = readStoredConfig().oauth;
  if (!oauth || typeof oauth !== "object") {
    return null;
  }
  const required: (keyof OAuthSession)[] = [
    "clientId",
    "accessToken",
    "refreshToken",
    "cloudId",
    "site",
  ];
  for (const key of required) {
    if (typeof oauth[key] !== "string" || oauth[key] === "") {
      return null;
    }
  }
  if (typeof oauth.expiresAt !== "number") {
    return null;
  }
  // Optional fields are sanitised rather than trusted: a corrupted non-string
  // clientSecret must never flow into a token request body.
  return {
    clientId: oauth.clientId,
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    cloudId: oauth.cloudId,
    site: oauth.site,
    scopes: typeof oauth.scopes === "string" ? oauth.scopes : "",
    ...(typeof oauth.clientSecret === "string" && oauth.clientSecret !== ""
      ? { clientSecret: oauth.clientSecret }
      : {}),
  };
}

/** Persist the OAuth session (whole-object write; preserves site/email/token). */
export function saveOAuthSession(session: OAuthSession): void {
  const stored = readStoredConfig();
  writeStoredConfig({ ...stored, oauth: session });
}

/** Drop only the OAuth session, keeping any API-token credential intact. */
export function clearOAuthSession(): void {
  const stored = readStoredConfig();
  if (!stored.oauth) {
    return;
  }
  const rest = { ...stored };
  delete rest.oauth;
  writeStoredConfig(rest);
}

/**
 * Resolve the OAuth client secret: env `ATLASSIAN_AXI_OAUTH_CLIENT_SECRET`
 * wins over the secret stored with the session (written on first login).
 * Both read paths run through `sanitizeToken` — the secret is human-pasted
 * exactly like the API token, so the same quote-wrapping corruption applies.
 */
export function resolveOAuthClientSecret(
  session?: OAuthSession | null,
): { secret: string; source: "env" | "config" } | null {
  const env = sanitizeToken(envValue("ATLASSIAN_AXI_OAUTH_CLIENT_SECRET") ?? "");
  if (env) {
    return { secret: env, source: "env" };
  }
  const stored = session ?? readOAuthSession();
  const fromStore = sanitizeToken(stored?.clientSecret ?? "");
  if (fromStore) {
    return { secret: fromStore, source: "config" };
  }
  return null;
}

/**
 * Which auth mode drives the Confluence REST half. Resolution order
 * (documented in `auth --help`):
 *   1. `ATLASSIAN_API_TOKEN` env (an explicit agent/CI override) — API-token
 *      mode; if site/email are missing this is a loud config error, never a
 *      silent fallback to OAuth.
 *   2. A persisted OAuth session — OAuth (Bearer via api.atlassian.com) mode.
 *   3. A complete stored API-token credential — API-token mode.
 */
export type AuthMode =
  | { mode: "oauth"; oauth: OAuthSession; signIn?: SignInPlace }
  | {
      mode: "api-token";
      credential: AtlassianCredential;
      sources: ResolvedCredential["sources"];
      /** Where the token is kept, from the settings alone. */
      signIn?: SignInPlace;
    }
  | {
      /**
       * An API-token sign-in whose token is in this computer's password store
       * and was NOT read, because the caller asked for it not to be
       * (`askStore: false`: `auth status` and the home view).
       */
      mode: "api-token-unread";
      site: string;
      email: string;
      signIn: SignInPlace;
    }
  | { mode: "none"; missing: string[] };

export interface AuthModeOptions {
  /**
   * false: never ask this computer's password store. A sign-in the settings
   * record there comes back as `api-token-unread`. For `auth status` and the
   * home view, which say where the sign-in is from the settings alone. (A
   * sign-in from before the standard is read as it always was.)
   */
  askStore?: boolean;
}

export async function resolveAuthMode(
  options: AuthModeOptions = {},
): Promise<AuthMode> {
  // Site, email and an environment token first: none of them asks a store,
  // and two of the three outcomes below need nothing else.
  const settled = await resolveCredential({ storedSecret: false });
  const modeOf = (resolved: ResolvedCredential, signIn: SignInPlace): AuthMode => ({
    mode: "api-token",
    credential: {
      site: resolved.site as string,
      email: resolved.email as string,
      apiToken: resolved.apiToken as string,
    },
    sources: resolved.sources,
    signIn,
  });

  if (settled.sources.apiToken === "env") {
    if (settled.site && settled.email) {
      return modeOf(settled, "environment (ATLASSIAN_API_TOKEN, saved nowhere)");
    }
    const missing = [
      !settled.site ? "site" : null,
      !settled.email ? "email" : null,
    ].filter((v): v is string => v !== null);
    return { mode: "none", missing };
  }

  const oauth = readOAuthSession();
  if (oauth) {
    // A browser sign-in is always in the file: Atlassian replaces its secret
    // on every renewal, which an everyday command cannot write to a store.
    return { mode: "oauth", oauth, signIn: "private file" };
  }

  const stored = readStoredConfig();
  if (
    options.askStore === false &&
    stored.store === "keyring" &&
    settled.site &&
    settled.email
  ) {
    return {
      mode: "api-token-unread",
      site: settled.site,
      email: settled.email,
      signIn: "password store",
    };
  }
  const resolved = await resolveCredential();
  if (resolved.site && resolved.email && resolved.apiToken) {
    return modeOf(resolved, placeOf(stored));
  }
  const missing: string[] = [];
  if (!resolved.site) missing.push("site");
  if (!resolved.email) missing.push("email");
  if (!resolved.apiToken) missing.push("apiToken");
  return { mode: "none", missing };
}

/** Resolve an active auth mode or throw AUTH_REQUIRED naming both login paths. */
export async function requireAuth(): Promise<
  Exclude<AuthMode, { mode: "none" | "api-token-unread" }>
> {
  const mode = await resolveAuthMode();
  if (mode.mode === "none" || mode.mode === "api-token-unread") {
    const missing = mode.mode === "none" ? mode.missing : ["apiToken"];
    throw new AxiError(
      `Not authenticated (missing: ${missing.join(", ")})`,
      "AUTH_REQUIRED",
      [
        "Run `confluence-axi auth login` for the OAuth browser flow (interactive terminals)",
        "Or `echo -n \"<token>\" | confluence-axi auth login --token --site <site> --email <email>` (agents/CI)",
      ],
    );
  }
  return mode;
}

/**
 * Whether this invocation can drive a browser login: both stdin and stdout
 * must be interactive terminals. Agents/CI pipe at least one of them — the
 * OAuth flow must fail fast there instead of hanging on a browser.
 */
export function isInteractiveTTY(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export interface ClearedCredential {
  /** What became of the item in this computer's password store, when the sign-in was kept there. */
  item?: "removed" | "left";
  /** The item's label, so a person can find one that could not be removed. */
  label?: string;
  why?: string;
}

/**
 * Remove all persisted state: the config file, the item in this computer's
 * password store, and the earlier Mac keychain item. The settings go even
 * when the item cannot be removed (a locked store); the answer then says so
 * and names it.
 */
export async function clearCredential(): Promise<ClearedCredential> {
  const stored = readStoredConfig();
  const path = configPath();
  if (existsSync(path)) {
    rmSync(path, { force: true });
  }
  const cleared: ClearedCredential = {};
  for (const item of itemsOf(stored)) {
    const removed = await removeSignInItem(item.email, item.site);
    if (removed.state === "removed") {
      cleared.item = "removed";
      cleared.label = removed.label;
    } else if (stored.store === "keyring" && removed.state !== "missing") {
      // It was there by the settings' own account, and it is still there.
      cleared.item = "left";
      cleared.label = removed.label;
      cleared.why = removed.reason ?? "the password store did not answer";
    }
  }
  const keychain = getKeychain();
  if (keychain) {
    try {
      await keychain.remove();
    } catch {
      // Nothing stored / already removed — clearing is best-effort.
    }
  }
  return cleared;
}

// ---------------------------------------------------------------------------
// Token from stdin (never argv; TTY throws — mirrors gh-axi's secret handling)
// ---------------------------------------------------------------------------

/** Whether stdin is an interactive terminal (no piped input available). */
export function isStdinTTY(): boolean {
  return Boolean(process.stdin.isTTY);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function tokenRequiredError(): AxiError {
  return new AxiError(
    "API token is required: pipe it via stdin (never passed as an argument)",
    "VALIDATION_ERROR",
    [
      `echo -n "<token>" | confluence-axi auth login --token --site <site> --email <email>`,
    ],
  );
}

/**
 * Normalize a piped token: trim, then strip ONE pair of matching surrounding
 * quotes. A quote-wrapped paste (e.g. a JSON value copied without `jq -r`)
 * otherwise reaches the keychain verbatim and every REST call fails —
 * Confluence v2 answers the resulting anonymous request with 404, which reads
 * as a URL bug instead of a credential bug.
 */
export function sanitizeToken(raw: string): string {
  const trimmed = raw.trim();
  const wrapped = trimmed.match(/^(["'])(.*)\1$/s);
  return wrapped ? (wrapped[2] as string).trim() : trimmed;
}

/**
 * Read the API token from stdin. On an interactive TTY it asks through
 * `askAtTerminal` (a hidden prompt, so a person can paste the token into one
 * plain command with no pipe); without one it throws (never blocks). Rejects
 * an empty answer, strips one pair of surrounding quotes, and rejects tokens
 * carrying internal whitespace or control characters (a real Atlassian API
 * token has neither — their presence means a mangled paste). The token is
 * only ever read here — never from a CLI flag/argv.
 */
export async function readTokenFromStdin(
  askAtTerminal?: () => Promise<string>,
): Promise<string> {
  if (isStdinTTY() && !askAtTerminal) {
    throw tokenRequiredError();
  }
  const value = sanitizeToken(
    isStdinTTY() && askAtTerminal ? await askAtTerminal() : await readStdin(),
  );
  if (value.length === 0) {
    throw tokenRequiredError();
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(value)) {
    throw new AxiError(
      "API token contains whitespace or control characters — it looks mangled (quoted, wrapped, or multi-line paste)",
      "VALIDATION_ERROR",
      [
        "Copy the raw token value and re-pipe it: echo -n \"<token>\" | confluence-axi auth login",
      ],
    );
  }
  return value;
}
