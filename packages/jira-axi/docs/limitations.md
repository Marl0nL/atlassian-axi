# Limitations and caveats

Everything `jira-axi` deliberately cannot do, plus behaviors that will surprise an agent.

Consult this before attempting an operation that may silently fail, no-op, or return misleading output.

## No native `workitem list`; unbounded JQL is rejected

acli has no `workitem list` subcommand; the CLI builds JQL and calls `workitem search`.
acli rejects unbounded JQL, so a bare `workitem list` with no filters applies an `updated >= -30d` window.
To go wider, pass explicit `--jql` or use `workitem search "<JQL>"` with a bounded query.
An empty result under this default window discloses it in a `scope:` line, so `count: 0` is not mistaken for "no work items exist".

## `search --fields` whitelist rejects some fields

The `--fields` whitelist for `list`/`search` rejects fields absent from list output, e.g. `updated`.
Inspect time fields with `workitem view <KEY> --fields <a,b,c>` instead (view accepts a broader set).

## Work item links: what acli gives, and what the CLI adds

`link`, `unlink`, `list-links` and `link-types` cover item-to-item links only.
Remote links (a linked Confluence page or URL) are not supported, and epic/parent membership is the `parent` field, not a link (see `workitem create --parent`).

acli's own link surface is thin, so the CLI reads around it:

- acli's `link list` JSON carries only `{id, outwardIssueKey, typeName}`, with a null key for every link where the listed item is on the outward side. `list-links` and `view --links` therefore read the item's `issuelinks` field instead, which has both ends, the type's phrases, and the other item's summary and status.
- acli's `link type` returns names only. `link-types` reads each type's phrases off an existing link; a type nothing uses yet falls back to Jira's default phrases (flagged) or `unknown`.
- acli's `link create`/`link delete` have no `--json` and take `--out`/`--in`, which map verbatim onto Jira's REST `outwardIssue`/`inwardIssue`. That naming is backwards from how it reads: the item that DOES the blocking is `--in`. `jira-axi workitem link` hides this - give it the sentence you mean and check the `relation`/`inverse` rows it prints, which are re-read from Jira.

Linking is not transactional.
If Jira reports a link that reads the other way round than asked, `link` exits non-zero and prints the `unlink` command for it, rather than leaving a wrong link reported as success.

## No field list or view

`field` is mutations only: `create`, `update`, `delete`, `restore`.
acli has no field list/view - inspect field values with `workitem view <KEY> --fields <a,b,c>`.
`field delete` and `field restore` have no `--json` from acli, so the CLI renders its own confirmation.
`delete` moves the field to trash (restorable via `restore`).

## No dashboard list/view beyond search

acli `dashboard` has only `search`; the CLI's `dashboard list` maps onto it.
There is no `dashboard view`.

## `sprint list-workitems` requires both IDs

`sprint list-workitems <ID>` requires BOTH the sprint ID and `--board <ID>` (a Jira agile API constraint).
Find board IDs via `board list`, sprint IDs via `board list-sprints <BOARD_ID>`.

## Comment rendering is lossy

`workitem view --comments` is lossy: acli flattens ADF comment bodies upstream (drops list items, strips marks to double spaces).
The CLI can only render what acli returns.
The stored comment ADF is intact - verify the true content in the Jira UI, not through acli.

## Mutations are non-interactive and `--yes`-gated

All Jira mutations run `--yes`-gated and non-interactive by design; there are no interactive prompts.
Mutations are idempotent and re-fetch after applying: `transition --to <status>` and `sprint update --state` are no-op successes when already in that state, so re-running a failed mutation is safe.

## TOON output only

All structured output is TOON-encoded.
There is no plain-text or JSON output mode.
Long free text is truncated by default with a size marker; the detail command that renders it takes `--full` for the complete text. See [commands](./commands.md) for the commands that accept it.
The truncation baseline is 500 characters (`BODY_TRUNCATE_LENGTH` in `src/commands/jira/shared.ts`), applied uniformly to every free-text field - work item descriptions and comments, filter and project descriptions - so the cut point is predictable rather than per-command.

## Flags must come after the command

Flags are rejected before the command name.
Write `jira-axi workitem list --project TEAM`, not `jira-axi --project TEAM workitem list`.
An unrecognised flag is never silently ignored: it is a loud `VALIDATION_ERROR` (exit 2) whose `help` block enumerates the flags that command does support.
