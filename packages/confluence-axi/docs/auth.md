# auth

Manage the Atlassian credential that `confluence-axi` uses for the Confluence REST API.

Use these commands to log in, inspect the active credential, or clear it.
There are two auth modes: an OAuth 2.0 browser flow (default `auth login`) and an API-token flow (`auth login --token`, for agents/CI).

This CLI talks only to Confluence and never bootstraps `acli`.
The Jira half lived in the old combined `atlassian-axi` and is now the separate `jira-axi` bin.

## Auth modes

**OAuth (3LO) browser flow** - the default `auth login`.
Uses Bearer tokens against `api.atlassian.com`, auto-refreshed.
Requires an interactive TTY; fails fast with `VALIDATION_ERROR` when stdin/stdout is not a terminal.
There is no shipped OAuth app: you must register your own Atlassian 3LO app once and set `ATLASSIAN_AXI_OAUTH_CLIENT_ID` (and supply the secret). See [Registering your own OAuth app](#registering-your-own-oauth-app) below.
If you need Confluence non-interactively, prefer the API-token mode.

**API token** - `auth login --token`.
Stores site + email + API token for headless use.
The token is read from stdin only, never passed as an argument.

## Credential resolution order

`ATLASSIAN_API_TOKEN` env > stored OAuth session > stored API token.

A half-configured env token (env var set but incomplete) resolves to a loud `none`, never a silent OAuth fallback.

## Environment variables

- `ATLASSIAN_SITE` - site host, e.g. `mysite.atlassian.net`.
- `ATLASSIAN_EMAIL` - account email.
- `ATLASSIAN_API_TOKEN` - API token; when set, takes precedence over any stored credential. It is used as it is and saved nowhere; `auth status` says when it is in use.
- `ATLASSIAN_AXI_OAUTH_CLIENT_ID` - client id of your own registered Atlassian OAuth app. Required for OAuth login; there is no shipped default (see [Registering your own OAuth app](#registering-your-own-oauth-app)).
- `ATLASSIAN_AXI_OAUTH_CLIENT_SECRET` - client secret of that app; env-supplied secrets are never persisted. If unset you are prompted once on first login and it is stored in the 0600 config.

## Where the sign-in is kept

The settings file is `~/.config/atlassian-axi/config.json` (it honours `XDG_CONFIG_HOME`), written mode `0600` (owner read/write only).
It always holds the site and the email, and it always decides which sign-in is in use.

The **API token** is kept in one of two places, and the settings file records which:

- **a private file on this computer**: the same settings file, under `token`.
- **this computer's password store**: GNOME Keyring or another Secret Service provider on Linux, the login keychain on a Mac. The settings file then holds no token, only `"store": "keyring"` and `secret_fingerprint`, a fingerprint that says which token it means.

No environment variable chooses between them (`ATLASSIAN_AXI_NO_KEYCHAIN` is gone and does nothing).
A flag at sign-in does, `--store`, and two commands move an existing sign-in: `auth store keyring` and `auth store file`.

**This release changes where nobody's sign-in is kept.**
A plain `auth login --token` puts the token where it went before: the settings file, or on a Mac the keychain item this tool has always used (service `atlassian-axi`, account `api-token`).
A sign-in saved by an earlier release keeps working as it did.
The password store is used only when a person asks for it, with `--store keyring` or `auth store keyring`.

**The token is read from the one place the settings say it is kept, and nowhere else.**
A password store that is locked, out of reach, empty, or holding a different token stops the command with one of the errors below.
It never falls back to a file.

| Code | It means |
| --- | --- |
| `KEYRING_LOCKED` | The password store is locked. Unlock it (log in to the desktop with your password), then run the command again. |
| `KEYRING_BLOCKED` | The password store cannot be reached from inside an agent sandbox. Run the command outside the sandbox. |
| `KEYRING_UNAVAILABLE` | This session has no password store to ask (SSH without a desktop, a container). |
| `KEYRING_FAILED` | The password store did not answer within 3 seconds, or answered something that makes no sense. Running the command again is safe. |
| `SIGN_IN_MISSING` | The saved sign-in is not there any more. A person signs in again. |
| `SIGN_IN_MISMATCH` | What was found is not the token saved at sign-in, so it was not used and nothing was sent. A person signs in again. |
| `SIGN_IN_STORE_UNKNOWN` | The settings name a store this version does not know. Update the tool. |

### What the password store costs in this tool

An API token is sent with every request, and there is no hourly pass to fall back on.
So with the token in the password store, **every command that talks to Confluence asks the password store, and none of them works inside a Linux agent sandbox**, which cannot reach it.
`auth status` and the no-argument dashboard are the exceptions: they never ask the password store, and say where the sign-in is from the settings file alone.
(One exception to that, unchanged from before: on a Mac, a sign-in from before `--store` existed is still in this tool's old keychain item, and every command, these two included, reads it there as it always did, with a 3 second limit. `auth store keyring` moves it to the standard item, after which they stop asking.)
If your agent runs this tool inside a sandbox, keep the sign-in in the file.

### What this protects, and what it does not

**It is not a security boundary.**
Any program running as you can ask an unlocked password store for the token, with no window and no record, as it can read the file. It can also replace or delete the item; the fingerprint turns a replacement into a refusal, not into a token kept.

What the password store changes: the token is not a file an agent stumbles on with `cat` or `grep`; it is not in a backup, a synced home folder or a screen share of the settings folder; and it is out of reach of a sandboxed command on Linux.
It does not help against a program running as you that decides to ask, against the tool itself (which holds the token in memory and sends it over the network), or against copies already made: a backup taken while the token was in the file still holds a working token, and only revoking it at Atlassian and signing in again retires it.
Signing in with the same token to `jira-axi` leaves a second copy with Atlassian's own `acli`, which this tool does not manage.

### What has been run, and where

- **Linux with GNOME Keyring: tested**, against a real GNOME Keyring on a private session bus in a throwaway home (`test/keyring-lab.test.ts`), from the source and from the built package.
- **KDE Wallet and KeePassXC: not tested.** Anything unexpected ends in an error at sign-in and the sign-in stays where it was.
- **macOS: untested. Nobody has run this on a Mac.** The keychain is reached through the shared client's `/usr/bin/security` path, which was written from Apple's documentation and tried only against a stand-in. That now includes the keychain item this tool has always used: the token is no longer passed as an argument (it goes down standard input), and a keychain that is locked or does not answer is an error where it used to be taken for "nothing there".
- **Windows: not supported.**

### The browser (OAuth) sign-in

The OAuth session (tokens + cloudId + site + optionally the client secret) is stored whole in the `0600` settings file under `oauth:`, always.
Atlassian replaces its refresh token on every renewal, and an everyday command may not write a password store, so this sign-in cannot move there: `auth store keyring` says so and changes nothing.
The OAuth session and the API-token credential coexist; all writes merge and never clobber the other.

## `confluence-axi auth login`

OAuth 2.0 browser login.
Opens `auth.atlassian.com`, catches the `http://localhost:8765/callback` redirect, and stores tokens + cloudId in the `0600` config.

**Flags:**
- `--site <site>` - pre-select among multiple accessible sites (optional; e.g. `mysite.atlassian.net`).

```bash
export ATLASSIAN_AXI_OAUTH_CLIENT_ID=<your app client id>
export ATLASSIAN_AXI_OAUTH_CLIENT_SECRET=<your app client secret>   # or omit and paste when prompted
confluence-axi auth login
```

**Caveats:**
- Requires your own registered OAuth app; there is no shipped default. See [Registering your own OAuth app](#registering-your-own-oauth-app).
- Requires an interactive TTY. Fails with `VALIDATION_ERROR` when stdin/stdout is not a terminal - use `--token` for agents/CI.
- The callback is pinned to `http://localhost:8765/callback`; port 8765 must be free during login.
- Client secret resolution: `ATLASSIAN_AXI_OAUTH_CLIENT_SECRET` env, otherwise prompted once (hidden, on stderr) and stored in the `0600` config.
- When you have access to more than one site and do not pass `--site`, it lists your accessible sites and prompts you to pick one.
- `auth login` fails loud on anything it does not consume: any leftover flag or argument is a `VALIDATION_ERROR` (exit 2) listing the supported flags. A typo'd `--tokn` is rejected outright instead of silently falling through to the OAuth path (which, in an agent or CI shell, would surface the misleading "needs an interactive terminal" error), and a typo'd `--emial` cannot quietly log you in under a stale resolved email.

## `confluence-axi auth login --token`

API-token login. No browser.
At a terminal it asks for the token at a hidden prompt, so the whole sign-in is one plain command; for agents/CI the token is piped.
Persists the credential to the store for use against the Confluence REST API.

**Flags:**
- `--token` (required) - selects API-token mode; the token itself is read from stdin, never as an argument.
- `--site <site>` - site host (optional; falls back to `ATLASSIAN_SITE`, then the stored value, then Reposit's own site, `repositpower.atlassian.net`).
- `--email <email>` - account email (optional; falls back to `ATLASSIAN_EMAIL` then stored value).
- `--store <auto|keyring|file>` - where the token is kept (optional; see [Where the sign-in is kept](#where-the-sign-in-is-kept)).
  - `auto` (the default): where the settings already say this sign-in is kept; for a new sign-in the settings file, or on a Mac the keychain item this tool has always used.
  - `keyring`: this computer's password store. The token is written, read back and compared before anything is recorded; if the store cannot be used from here the sign-in is **refused** with the matching code and nothing is saved.
  - `file`: the settings file, recorded as chosen.

```bash
# at a terminal: paste the token when asked (it shows as stars)
confluence-axi auth login --token --email me@repositpower.com
# piped (agents/CI)
echo -n "$TOKEN" | confluence-axi auth login --token --site acme.atlassian.net --email me@acme.com
# into this computer's password store (a person, at their desktop)
confluence-axi auth login --token --email me@repositpower.com --store keyring
```

**Caveats:**
- The token is never an argument: it arrives on stdin, or at the hidden prompt when stdin is a terminal.
- The login output's `sign_in:` line says, in one sentence, where the sign-in was kept and why.
- With `--store keyring` and a locked password store, the store may ask you to unlock it: a person is signing in. No other command ever causes a password window.

## `confluence-axi auth status`

Report the active mode, where the sign-in is kept (`sign_in: password store`, `private file`, or the environment), token expiry, and the Confluence REST half.

```bash
confluence-axi auth status
confluence-axi auth status --check
```

**Flags:**
- `--check` - also ask this computer's password store whether the sign-in can be read from where it is kept, and report it as the `sign_in_store:` row. This is the one check that asks the store: 3 seconds at most, never a password window, and the token is dropped as soon as its fingerprint has been checked. Exits 1, with the matching code, when it cannot be read.

**Caveats:**
- Read-only; safe to run repeatedly.
- The overall ok/degraded verdict gates on the Confluence REST ping.
- Without `--check` it never asks the password store (the old Mac keychain item excepted, as above). With the token kept there it cannot ping Confluence either, and says `status: not checked` (exit 0): run `auth status --check` outside a sandbox for the real answer.
- For a sign-in still in the file, `--check` says when a password store is available to move it to, and what that costs.

## `confluence-axi auth store keyring` / `auth store file`

Move the API-token sign-in between the two places it can be kept. A person runs these, outside any sandbox: they change the settings folder.

```bash
confluence-axi auth store keyring   # into this computer's password store
confluence-axi auth store file      # back into the settings file
```

- `store keyring` writes the item, reads it back and compares it **before** the settings file changes, and the settings file changes in one rename. If the password store cannot be used (none in this session, locked and not unlocked, out of reach), **nothing changes**: the sign-in stays where it is, the command says why, and it exits 0 because the tool keeps working.
- `store file` is the mirror: the settings file gets the token back first, and only then is the item removed. If the item cannot be removed it says so and names its label.
- Killing either between its two steps leaves the token in both places, which is harmless. Running it again finishes the job.
- On a Mac, `store keyring` also moves a sign-in out of the keychain item this tool has always used into the item every Reposit agent tool uses (service `confluence-axi`, account `<email>/<site>`), and removes the old one once the new one is proven. Untested on a Mac.
- Neither moves a browser (OAuth) sign-in.
- The first line of output is the sentence that says where the sign-in is now.

**Going back to an earlier version of the tool:** run `auth store file` first on any machine where someone ran `auth store keyring` or signed in with `--store keyring`. An earlier version reads only the file (or, on a Mac, the old keychain item), and would say nobody is signed in.

## `confluence-axi auth logout`

Clear the OAuth tokens and the API-token sign-in, wherever it is kept: the settings file, the item in this computer's password store, and on a Mac the old keychain item.

```bash
confluence-axi auth logout
```

**Caveats:**
- Clears every stored credential half.
- Idempotent - safe to run when nothing is configured.
- If the item cannot be removed from the password store (a locked store), the settings still go, and the output names the item's label so you can remove it yourself.

## OAuth token refresh

Atlassian rotates refresh tokens on every refresh.
The session refreshes proactively on expiry (60s skew) and performs exactly one forced refresh + retry on a 401.
Each refresh persists the newest refresh token to the `0600` store.

## `--site` retargeting

`--site <site>` feeds credential resolution (flag > env > stored) and lets you target a different Atlassian instance.

- In OAuth mode the transport refuses an override differing from the session site (the cloudId is pinned).
- Atlassian API tokens are account-scoped, so one token serves every instance the account can reach.

See [limitations](./limitations.md) for the full `--site` caveat.

## Registering your own OAuth app

The OAuth browser flow needs an Atlassian 3LO app that you own.
This CLI ships none on purpose: Atlassian 3LO has no PKCE / public-client option and both its token and refresh grants require the client secret, so a distributed CLI cannot bundle a working app without shipping a secret (insecure) or running a hosted token broker (out of scope).
Registering your own app keeps the client id and secret entirely on your machine, which is Atlassian's own recommended pattern.
This is a one-time setup of a few minutes.

1. Open the [Atlassian developer console](https://developer.atlassian.com/console/myapps/) and create an app: **Create** -> **OAuth 2.0 integration**. Give it any name.
2. **Permissions** -> add the **Confluence API**, then grant these scopes: `read:confluence-content.all`, `write:confluence-content`, `read:confluence-space.summary`, `search:confluence`. (`offline_access` is requested automatically for refresh tokens.)
3. **Authorization** -> configure **OAuth 2.0 (3LO)** and set the **Callback URL** to EXACTLY `http://localhost:8765/callback`.
4. **Settings** -> copy the **Client ID** and generate/copy the **Secret**.
5. Provide them to the CLI as `ATLASSIAN_AXI_OAUTH_CLIENT_ID` and `ATLASSIAN_AXI_OAUTH_CLIENT_SECRET` (env), or set only the id and paste the secret when `auth login` prompts once (it is then stored in the 0600 config, never re-requested).

Notes:
- The callback must match `http://localhost:8765/callback` character-for-character or Atlassian rejects the redirect.
- Only Confluence scopes are requested.
- Env-supplied secrets are never written to disk; a prompted secret is stored in the 0600 config so you are not asked again.

## OAuth threat model

This CLI ships no OAuth app. You register your own Atlassian 3LO app and supply it via `ATLASSIAN_AXI_OAUTH_CLIENT_ID` and `ATLASSIAN_AXI_OAUTH_CLIENT_SECRET`, so the client credentials never leave your machine.
This is deliberate: Atlassian 3LO has no PKCE / public-client option and its token and refresh grants both require the client secret, so a distributed CLI cannot bundle a working app without either shipping a secret (insecure) or operating a hosted token broker (out of scope). Self-registration is Atlassian's own recommended pattern.
The runtime defenses are: the loopback-only callback (`http://localhost:8765/callback`), a single-use `state` parameter validated on return, and the `0600` on-disk store.
