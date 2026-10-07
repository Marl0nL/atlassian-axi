# jira-axi docs

Agent-ergonomic Jira CLI, backed by Atlassian's `acli`.
Every command emits token-efficient TOON output, mutations are idempotent, and errors carry next-step suggestions.

Install and invocation guidance lives in [Getting started](./getting-started.md#quick-start) - installing the agent skill is the recommended path, with zero-setup `npx` and a global install for session hooks as the other options.

`jira-axi` replaces the Jira half of the sunset combined `atlassian-axi` CLI; the Confluence half is now the separate `confluence-axi` package.

## Read this first

- [Getting started](./getting-started.md) - install, the `acli` prerequisite and login, first commands, session hooks.
- [Limitations](./limitations.md) - what the tool deliberately cannot do. Check here before an operation that might silently fail or no-op.
- [Release history](../CHANGELOG.md) - what changed in each published version.

## Command reference

- [Commands](./commands.md) - `workitem`, `project`, `board`, `sprint`, `filter`, `dashboard`, `field`; every subcommand, flag, and caveat.
- [Setup & update](./setup.md) - `setup hooks` (agent SessionStart context), `update` / `update --check`.

## Fast facts for agents

- Flags come AFTER the command: `jira-axi workitem list --project TEAM`, never before.
- Auth is delegated to `acli`: `jira-axi` stores no credentials. Run `acli jira auth login` once (install acli via `brew install acli`), or without a terminal pipe an API token to `jira-axi auth login --token --email <email>`; `jira-axi auth status` checks it.
- Work item and comment bodies accept a markdown subset (converted to ADF); raw ADF JSON passes through unchanged.
- Long free text truncates by default with a size marker; the detail command that renders it takes `--full` (see [commands](./commands.md)).
- All structured output is TOON-encoded. There is no plain-text or JSON mode.
- Mutations are non-interactive (`acli --yes`), idempotent, and re-fetch the post-state; re-running a failed mutation is safe.
- Links read as a sentence: `workitem link TEAM-1 --to TEAM-2 --type Blocks` means "TEAM-1 blocks TEAM-2"; pass the inward phrase (`--type "is blocked by"`) or `--reverse` for the other direction. `workitem view` shows a `links` row.
- Per-command help is always available: `jira-axi <resource> --help` (e.g. `jira-axi workitem --help`); `jira-axi workitem <subcommand> --help` prints one subcommand.
