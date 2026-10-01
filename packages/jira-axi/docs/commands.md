# Commands

`jira-axi <resource> <subcommand> [flags]` wraps Atlassian `acli` to read and mutate Jira work items, projects, boards, sprints, filters, dashboards, and custom fields.

Use these commands for any Jira operation.
Flags MUST come after the subcommand.
Requires `acli` installed (`brew install acli`) and logged in (`acli jira auth login`); see [getting started](./getting-started.md).
All output is TOON.

Resources are addressed two ways:
- `workitem` and `project` are KEY-addressed (e.g. `TEAM-1`, `TEAM`).
- `board`, `sprint`, `filter`, `dashboard`, `field` are ID-addressed (numeric).

## workitem

Work items are key-addressed (e.g. `TEAM-42`).
Mutations (`create`, `edit`, `transition`, `assign`, `comment`, `link`, `unlink`) run non-interactively with acli `--yes`, then re-fetch and render the authoritative post-state.

`jira-axi workitem --help` lists every subcommand; `jira-axi workitem <subcommand> --help` prints only that subcommand's flags and examples.
`--help` or `-h` ANYWHERE after a workitem subcommand prints that help and does nothing else - no read, no write - even in a flag's value position (`comment TEAM-1 --body --help` prints help; it does not post "--help").
The `--flag=--help` spelling is refused with `VALIDATION_ERROR` (exit 2). To store that literal text, pass it through `--body-file`.

Body inputs (`--body`/`--body-file` on `create`, `edit`, `comment`) accept a markdown SUBSET and are converted to real Jira ADF: headings, ordered + unordered + nested lists, inline code, fenced code blocks, bold, italic, links.
Raw ADF JSON is passed through unchanged.
It is NOT full CommonMark; unsupported markdown may render literally.

### `jira-axi workitem list`

List work items. Builds JQL internally and calls acli `workitem search` (acli has no `workitem list` subcommand).

**Flags:**
- `--jql <query>` verbatim JQL; exclusive with the filters below.
- `--project <KEY>`
- `--assignee <email|@me>`
- `--status <name>`
- `--limit <n>` (default 30)
- `--fields <a,b,c>`

```bash
jira-axi workitem list --project TEAM --status "In Progress"
```

**Caveats:**
- A bare `list` with no filters applies an `updated >= -30d ORDER BY updated DESC` window; acli rejects unbounded JQL.
- `--jql` combined with any of `--project`/`--assignee`/`--status` throws `VALIDATION_ERROR`.
- `--assignee @me` maps to `currentUser()`.

### `jira-axi workitem view <KEY>`

Show one work item.

**Flags:**
- `--comments` include comments.
- `--links` list the item's links (same rows as [`list-links`](#jira-axi-workitem-list-links-key)), from the same acli call.
- `--limit <n>` number of comments/links shown (default 30); requires `--comments` or `--links`.
- `--full` complete bodies without truncation.
- `--fields <a,b,c>` render only these fields; `key` is always included. `links` (alias of the Jira field `issuelinks`) renders the link summary.

```bash
jira-axi workitem view TEAM-1 --comments --limit 100
jira-axi workitem view TEAM-1 --links
```

The detail always carries a `links` row, read from this item's side: `0`, or the count plus an inline summary of up to five links, e.g. `links: 3 (blocks TEAM-2; is blocked by OPS-9; relates to OPS-3)`.
With `--links` the row is the bare count and the rows follow.

**Caveats:**
- The default render omits created/updated/priority unless requested; the CLI requests the full detail set by default.
- `--fields` with `--full` throws `VALIDATION_ERROR` (a `--fields` render is never truncated).
- `--limit` without `--comments` or `--links` throws `VALIDATION_ERROR` rather than being ignored.
- `links: unknown` means acli did not return the field; it is never rendered as `0`.
- The comments sub-list always prints a `count:` line (even at zero), reporting the true total so a shortened page is never silent.
- Fields acli did not return are reported in a `note:` line, so a null row is not mistaken for an empty value.
- `--comments` is lossy: acli flattens comment ADF upstream (drops list items, strips marks). See [limitations](./limitations.md). The stored comment ADF is intact in the Jira UI.

### `jira-axi workitem create`

Create a work item, then re-fetch and render it.

**Flags:**
- `--project <KEY>` (required)
- `--type <name>` (required)
- `--summary <text>` (required)
- `--body <text>` or `--body-file <path>` markdown description, stored as ADF.
- `--assignee <email|@me>`
- `--label <a,b>`

```bash
jira-axi workitem create --project TEAM --type Task --summary "Fix login"
```

**Caveats:**
- Missing any required flag throws `VALIDATION_ERROR`.
- If acli output has no detectable key, the CLI still reports success with a `message` field.

### `jira-axi workitem edit <KEY>`

Edit a work item, then re-fetch and render it.

**Flags:**
- `--summary <text>`
- `--body <text>` or `--body-file <path>` markdown description, stored as ADF.
- `--assignee <email|@me>`
- `--type <name>`
- `--labels <a,b>`
- `--remove-labels <a,b>`

```bash
jira-axi workitem edit TEAM-1 --summary "New title" --labels backend,urgent
```

**Caveats:**
- At least one changing flag is required; none throws `VALIDATION_ERROR`.

### `jira-axi workitem transition <KEY> --to <status>`

Move a work item to a status.

**Flags:**
- `--to <status>` (required)

```bash
jira-axi workitem transition TEAM-1 --to Done
```

**Caveats:**
- Idempotent: `--to` naming the current status is a no-op success (renders `message: "Already <status>"`), safe to retry.

### `jira-axi workitem assign <KEY> --assignee <user>`

Assign a work item.

**Flags:**
- `--assignee <email|@me>` (required)

```bash
jira-axi workitem assign TEAM-1 --assignee jane@acme.com
```

**Caveats:**
- Idempotent for a concrete user: if already assigned to that user, it is a no-op success. `@me` and `default` always resolve server-side and go through acli.

### `jira-axi workitem comment <KEY> --body <text>`

Add a comment, then re-fetch and render the item.

**Flags:**
- `--body <text>` or `--body-file <path>` (required) markdown, stored as ADF.

```bash
jira-axi workitem comment TEAM-1 --body "Deployed to staging"
```

### `jira-axi workitem search "<JQL>"`

Run a verbatim JQL query.

**Flags:**
- `--limit <n>` (default 30)
- `--fields <a,b,c>`

```bash
jira-axi workitem search "assignee = currentUser() AND resolution = EMPTY"
```

**Caveats:**
- The JQL positional is required; missing it throws `VALIDATION_ERROR`.

### `jira-axi workitem link <KEY> --to <KEY> --type <name|phrase>`

Link two work items.

A link reads as a sentence, and `--type` decides which way:

| `--type` | Reads | Example |
| --- | --- | --- |
| a type NAME | `<KEY> <outward phrase> <--to KEY>` | `link TEAM-1 --to TEAM-2 --type Blocks` = "TEAM-1 blocks TEAM-2" |
| a type NAME + `--reverse` | `<KEY> <inward phrase> <--to KEY>` | `link TEAM-1 --to TEAM-2 --type Blocks --reverse` = "TEAM-1 is blocked by TEAM-2" |
| a PHRASE | exactly as written | `link TEAM-1 --to TEAM-2 --type "is blocked by"` = "TEAM-1 is blocked by TEAM-2" |

**Flags:**
- `--to <KEY>` (required) the other work item.
- `--type <name|phrase>` (required) a link type name, or one of its outward/inward phrases; matched case-insensitively. See [`link-types`](#jira-axi-workitem-link-types).
- `--reverse` with a type NAME: swap the two sides.

```bash
jira-axi workitem link TEAM-1 --to TEAM-2 --type Blocks
```

```
link:
  id: 10042
  relation: TEAM-1 blocks TEAM-2
  inverse: TEAM-2 is blocked by TEAM-1
  type: Blocks
  message: Linked
help[2]:
  Run `jira-axi workitem list-links TEAM-1` to see all its links
  Run `jira-axi workitem unlink TEAM-1 --id 10042` to remove this link
```

**Caveats:**
- Idempotent: if the link already exists it is a no-op success (`message: Already linked (no-op)`). For a type whose two phrases are the same (`Relates`) either stored direction counts; for a directional type the opposite direction is a different link.
- An unknown `--type` throws `VALIDATION_ERROR` (exit 2) with a did-you-mean and the site's types and phrases.
- A type NAME costs one extra acli call; a PHRASE costs the phrase lookup described under `link-types` (a few seconds).
- `--reverse` with a phrase throws `VALIDATION_ERROR`: the phrase already states the direction.
- Both work items are read before the write, so a wrong key is a `NOT_FOUND` that names it.
- The confirmation is re-read from Jira, not taken from acli's output. If the link is missing, or reads the other way round than asked, the command fails loudly and prints the `unlink` command to undo it.

### `jira-axi workitem unlink <KEY>`

Remove one link from a work item. Pass `--from` or `--id`.

**Flags:**
- `--from <KEY>` the other work item; removes the link between the two.
- `--type <name|phrase>` with `--from`: which link, when the two share several. A name matches either direction; a phrase matches the link that reads `<KEY> <phrase> <--from KEY>`.
- `--id <n>` a link id from `list-links`. It must be a link on `<KEY>`.

```bash
jira-axi workitem unlink TEAM-1 --from TEAM-2
jira-axi workitem unlink TEAM-1 --id 10042
```

**Caveats:**
- Idempotent: an absent link is a no-op success (`message: Already unlinked - ...`). When `--type` matched nothing but the two items are still linked another way, a `still_linked` row says how.
- More than one matching link throws `VALIDATION_ERROR` naming each with its id; the command never guesses which link to delete.
- `--id` only removes a link that is on `<KEY>`: an id belonging to other work items is a no-op, not a deletion.
- A typo'd `--type` throws `VALIDATION_ERROR` rather than reading as "already unlinked".
- `--from` with `--id`, or `--type` with `--id`, throws `VALIDATION_ERROR`.

### `jira-axi workitem list-links <KEY>`

List a work item's links.

**Flags:**
- `--limit <n>` (default 30)

```bash
jira-axi workitem list-links TEAM-1
```

```
count: 3
links[3]{relation,key,type,status,summary,id}:
  blocks,TEAM-2,Blocks,todo,Add audit log export,10042
  is blocked by,OPS-9,Blocks,wip,Rotate signing keys,10043
  relates to,OPS-3,Relates,done,"SSO outage, 12 July",10044
```

Each row reads `<KEY> <relation> <key>`: `relation` is the link type's own phrase from the listed item's side, so `TEAM-1 blocks TEAM-2` and `TEAM-1 is blocked by OPS-9`.
`status` and `summary` are the OTHER item's; `id` is what `unlink --id` takes.

**Caveats:**
- An item without links prints `count: 0` and `links: 0 work item links on <KEY>`.
- Jira returns all of an item's links at once, so `count` is the true total and `--limit` only shortens the rows shown.
- Item-to-item links only. Remote links (e.g. a linked Confluence page) and the epic/parent relationship (the `parent` field) are not links.

### `jira-axi workitem link-types`

List the site's link types with their outward and inward phrases - what `link --type` accepts.

```bash
jira-axi workitem link-types
```

```
count: 3
types[3]{name,outward,inward}:
  Blocks,blocks,is blocked by
  Duplicate,duplicates,is duplicated by
  Relates,relates to,relates to
```

**Caveats:**
- acli returns type NAMES only. The phrases are read off a real link: one bounded JQL search (`issueLinkType = "<name>"`, limit 1) plus one view per type, run in parallel. Expect a few seconds.
- A type no visible work item uses yet has no link to read from. For Jira's shipped types the documented default phrases are shown and a `note:` line flags them as unconfirmed; for a custom type the phrases show as `unknown`. Link such a type by NAME and read the phrase `link` prints.

## project

Projects are key-addressed (e.g. `TEAM`).

### `jira-axi project list`

List projects.

**Flags:**
- `--limit <n>` (default 30)

```bash
jira-axi project list
```

### `jira-axi project view <KEY>`

Show one project.

**Flags:**
- `--full` complete description without truncation.

```bash
jira-axi project view TEAM
```

**Caveats:**
- The description is truncated with a size marker unless `--full` is passed.

## board

Boards are ID-addressed (numeric).

### `jira-axi board list`

List boards. Maps onto acli `board search` (acli has no `board list`).

**Flags:**
- `--name <substring>`
- `--project <KEY>`
- `--type <scrum|kanban|simple>`
- `--limit <n>` (default 30)

```bash
jira-axi board list --project TEAM
```

### `jira-axi board view <ID>`

Show one board.

```bash
jira-axi board view 1013
```

### `jira-axi board list-sprints <ID>`

List sprints on a board.

**Flags:**
- `--state <future,active,closed>` comma-separated.
- `--limit <n>` (default 30)

```bash
jira-axi board list-sprints 1013 --state active
```

### `jira-axi board list-projects <ID>`

List projects associated with a board.

**Flags:**
- `--limit <n>` (default 30)

```bash
jira-axi board list-projects 1013
```

## sprint

Sprints are ID-addressed (numeric).
Dates render as `YYYY-MM-DD`, not relative times.

### `jira-axi sprint view <ID>`

Show one sprint.

```bash
jira-axi sprint view 5205
```

### `jira-axi sprint list-workitems <ID> --board <ID>`

List work items in a sprint.

**Flags:**
- `--board <ID>` (required by the Jira agile API)
- `--jql <query>`
- `--fields <a,b,c>`
- `--limit <n>` (default 30)

```bash
jira-axi sprint list-workitems 5205 --board 1013
```

**Caveats:**
- Both the sprint ID positional AND `--board` are required; the agile API needs both.

### `jira-axi sprint create --board <ID> --name <text>`

Create a sprint.

**Flags:**
- `--board <ID>` (required)
- `--name <text>` (required)
- `--start <ISO date>`
- `--end <ISO date>`
- `--goal <text>`

```bash
jira-axi sprint create --board 1013 --name "Sprint 13" --goal "Ship checkout"
```

### `jira-axi sprint update <ID>`

Update a sprint.

**Flags:**
- `--name <text>`
- `--goal <text>`
- `--state <future|active|closed>`
- `--start <ISO date>`
- `--end <ISO date>`

```bash
jira-axi sprint update 5205 --state closed
```

**Caveats:**
- Idempotent on state: `--state` naming the current state is a no-op success, safe to retry.

## filter

Filters are ID-addressed (numeric).

### `jira-axi filter list`

List filters. Defaults to filters you own.

**Flags:**
- `--favourite` list your favourite filters instead of owned ones.
- `--limit <n>` (default 30, applied client-side)

```bash
jira-axi filter list
```

**Caveats:**
- The upstream API requires exactly one of my/favourite; the CLI defaults to owned (`--my`) and `--favourite` switches to favourites.
- The slice is client-side, so the `count:` line is the true total and names the exact `--limit` value that reveals every filter.

### `jira-axi filter search`

Search filters.

**Flags:**
- `--name <substring>`
- `--owner <email>`
- `--limit <n>` (default 30)

```bash
jira-axi filter search --name backlog
```

### `jira-axi filter view <ID>`

Show one filter.

**Flags:**
- `--full` complete description without truncation.

```bash
jira-axi filter view 33312
```

**Caveats:**
- The description is truncated with a size marker unless `--full` is passed. `filter update` has no `--full` and always renders the truncated form.

### `jira-axi filter update <ID>`

Update a filter.

**Flags:**
- `--name <text>`
- `--description <text>`
- `--jql <query>`

```bash
jira-axi filter update 33312 --jql "project = TEAM AND status = Open"
```

**Caveats:**
- Idempotent: an update that changes nothing is a no-op success, safe to retry.

## dashboard

Dashboards are ID-addressed. Only `list` is available (maps onto acli `dashboard search`; acli has no `dashboard list`).

### `jira-axi dashboard list`

List dashboards.

**Flags:**
- `--name <substring>`
- `--owner <email>`
- `--limit <n>` (default 30)

```bash
jira-axi dashboard list --name release --owner jane@acme.com
```

## field

Custom fields are ID-addressed (`customfield_<n>`). acli has NO field `list`/`view` - only the mutations below.

To inspect field VALUES on a work item, use `jira-axi workitem view <KEY> --fields <a,b,c>` instead.
A bare numeric ID `<n>` is accepted and expanded to `customfield_<n>` (the expanded ID is echoed in the output).

### `jira-axi field create --name <text> --type <key>`

Create a custom field.

**Flags:**
- `--name <text>` (required)
- `--type <key>` (required) full type key, e.g. `com.atlassian.jira.plugin.system.customfieldtypes:textfield`.
- `--description <text>`
- `--searcher-key <key>`

```bash
jira-axi field create --name "Customer Name" --type "com.atlassian.jira.plugin.system.customfieldtypes:textfield"
```

### `jira-axi field update <ID>`

Update a custom field.

**Flags:**
- `--name <text>`
- `--description <text>`
- `--searcher-key <key>`

```bash
jira-axi field update customfield_12345 --name "Client Name"
```

### `jira-axi field delete <ID>`

Move a custom field to trash.

```bash
jira-axi field delete customfield_12345
```

**Caveats:**
- Delete moves the field to trash; it is restorable with `restore`.
- acli has no `--json` for delete/restore, so the CLI renders its own confirmation.

### `jira-axi field restore <ID>`

Restore a trashed custom field.

```bash
jira-axi field restore customfield_12345
```

## See also

- [Getting started](./getting-started.md) - the `acli` prerequisite and login.
- [Limitations](./limitations.md) - known lossy behaviors (e.g. comment ADF flattening).
- [Setup & update](./setup.md) - `setup hooks`, `update`.
