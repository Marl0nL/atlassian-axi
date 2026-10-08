// Types for keyring.mjs (reposit-keyring-client 1.0.0). Copied with it, never edited in a copy.

export declare const VERSION: string;

/** What a keyring call found. Anything but found/stored/removed/usable carries a `reason` made by the client. */
export type KeyringState = "found" | "stored" | "removed" | "usable" | "missing" | "locked" | "blocked" | "no-bus" | "no-keyring" | "failed";

export interface KeyringOptions {
  /** The tool's command name. */
  service: string;
  /** The account, lower-cased by the client: an email, or an email and a site. */
  account: string;
  /** Where to find the session bus. Default: process.env. */
  env?: Record<string, string | undefined>;
  /** Time limit of the call in milliseconds. Default 3000, never more than 10000. */
  limitMs?: number;
  /** Tests only. */
  platform?: string;
  /** Tests only. */
  securityPath?: string;
}

export interface KeyringResult {
  state: KeyringState;
  reason?: string;
  secrets?: string[];
  provider?: string;
}

export interface StoreOptions extends KeyringOptions {
  label: string;
  secret: string;
  /** True only while a person is signing in: the keyring may then ask them to unlock it. */
  interactive?: boolean;
  promptMs?: number;
}

/** The commands the standard's errors name. Defaults: `<name> renew`, `<name> auth login`, `<name> doctor`. */
export interface ToolWords {
  name?: string;
  /** false for a tool with no hourly pass to renew (an API token). */
  renew?: string | false;
  login?: string;
  doctor?: string;
}

export type SignInCode = "KEYRING_LOCKED" | "KEYRING_BLOCKED" | "KEYRING_UNAVAILABLE" | "KEYRING_FAILED" | "SIGN_IN_MISSING" | "SIGN_IN_MISMATCH" | "SIGN_IN_STORE_UNKNOWN";

export interface SignInError {
  ok: false;
  code: SignInCode;
  message: string;
  help: string;
  state?: KeyringState | "mismatch";
}

export type FileReason = "chosen" | "no-bus" | "no-keyring" | "locked" | "blocked" | "failed";

/** What sign-in writes into the settings folder. */
export type SavedSignIn =
  | { store: "keyring"; fingerprint: string; provider?: string }
  | { store: "file"; fingerprint: string; reason: FileReason; detail?: string };

export declare function probe(options?: Partial<KeyringOptions>): Promise<KeyringResult>;
export declare function lookup(options: KeyringOptions): Promise<KeyringResult>;
export declare function store(options: StoreOptions): Promise<KeyringResult>;
export declare function remove(options: KeyringOptions): Promise<KeyringResult>;
export declare function fingerprint(service: string, account: string, secret: string): string;
export declare function signInError(code: SignInCode, tool?: ToolWords, reason?: string): SignInError;
export declare function describeStore(saved: { store?: string; reason?: string; provider?: string }): string;
export declare function saveSignIn(options: StoreOptions & { want?: "auto" | "keyring" | "file"; tool?: ToolWords }): Promise<SavedSignIn | SignInError>;
export declare function loadSignIn(
  options: KeyringOptions & { store?: string; fingerprint?: string; fileSecret?: string; tool?: ToolWords },
): Promise<{ ok: true; secret: string } | SignInError>;
