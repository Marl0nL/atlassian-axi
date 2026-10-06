import { acliJson } from "../../acli.js";
import { bodyToAdf, writeAdfDocTempFile, writeAdfTempFile } from "../../adf.js";
import { BODY_FLAGS, takeBody } from "@atlassian-axi/core";
import type { SiteContext } from "@atlassian-axi/core";
import { AxiError } from "@atlassian-axi/core";
import { unknownSubcommandError } from "@atlassian-axi/core";
import { formatCountLine } from "@atlassian-axi/core";
import { getSuggestions } from "../../suggestions.js";
import {
  custom,
  field,
  renderDetail,
  renderHelp,
  renderList,
  renderOutput,
} from "@atlassian-axi/core";
import {
  LINKS_ALIAS,
  LINKS_FIELD,
  WORKITEM_KEY,
  commentSchema,
  fieldsSchema,
  fieldOf,
  itemsOf,
  linksOf,
  nameOf,
  parseFlags,
  parseLimit,
  quoteJql,
  rejectExtraPositional,
  requireWorkitemKey as requireKey,
  splitFields,
  totalOf,
  workitemListSchema,
  workitemViewSchema,
  type JsonRecord,
} from "./shared.js";
import {
  MAX_MENTIONS,
  bareMentionNote,
  commentsOf,
  describePerson,
  distinctPeople,
  mentionRequests,
  peopleOnTicket,
  resolveMentions,
  storedMentions,
  type PeopleSearch,
  type Person,
  type StoredMention,
} from "./mentions.js";
import {
  WORKITEM_HELP,
  WORKITEM_SUBCOMMANDS,
  workitemHelp,
  workitemHelpRequest,
} from "./workitem-help.js";
import {
  linkWorkitem,
  listLinkTypes,
  listWorkitemLinks,
  renderLinkList,
  unlinkWorkitem,
} from "./workitem-links.js";

// Help lives in workitem-help.ts (one table generates the whole-resource doc
// and every subcommand-scoped doc); re-exported for existing import sites.
export { WORKITEM_HELP, workitemHelp };

export async function workitemCommand(
  args: string[],
  ctx?: SiteContext,
): Promise<string> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    return WORKITEM_HELP;
  }

  // Help gate, before ANY handler: `--help`/`-h` anywhere after the subcommand
  // prints that subcommand's help and does nothing else. Without it a body or
  // value flag would swallow the token (`comment TEAM-1 --body --help`) and a
  // mutating subcommand would write the text "--help" to a real ticket.
  const help = workitemHelpRequest(args);
  if (help !== undefined) return help;

  switch (sub) {
    case "list":
      return listWorkitems(args, ctx);
    case "view":
      return viewWorkitem(args, ctx);
    case "create":
      return createWorkitem(args, ctx);
    case "edit":
      return editWorkitem(args, ctx);
    case "transition":
      return transitionWorkitem(args, ctx);
    case "assign":
      return assignWorkitem(args, ctx);
    case "comment":
      return commentWorkitem(args, ctx);
    case "search":
      return searchWorkitems(args, ctx);
    case "link":
      return linkWorkitem(args, ctx);
    case "unlink":
      return unlinkWorkitem(args, ctx);
    case "list-links":
      return listWorkitemLinks(args, ctx);
    case "link-types":
      return listLinkTypes(args, ctx);
    default:
      throw unknownSubcommandError(
        "workitem subcommand",
        sub,
        WORKITEM_SUBCOMMANDS,
        "jira-axi workitem --help",
      );
  }
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

// acli view's default field set omits created/updated/priority; request the
// full detail set explicitly (verified allowed against acli v1.3.22). `parent`
// rides along so epic/parent membership is always visible - an item created
// outside its intended epic was otherwise invisible until a separate JQL search.
// `issuelinks` rides along too: the detail view's `links` row (count + inline
// summary) and `--links` are rendered from this same payload, so an agent
// reading a ticket sees its links without a second call.
const VIEW_FIELDS = `key,summary,status,assignee,description,created,updated,priority,issuetype,parent,${LINKS_FIELD}`;

/**
 * Fetch one work item by key (acli view --json; tolerate array envelopes).
 * A user --fields list replaces the default detail set (`key` always rides
 * along so the render can anchor on it); `extra` names fields a flag needs on
 * top of either set (e.g. `--links` with `--fields summary`, or `comment`).
 */
async function fetchWorkitem(
  key: string,
  fields?: string[],
  extra: string[] = [],
): Promise<JsonRecord> {
  // `links` is this CLI's own spelling (the detail view's row name); acli only
  // knows the Jira field, `issuelinks`.
  const requested = fields
    ? [
        ...new Set([
          "key",
          ...fields.map((name) => (name === LINKS_ALIAS ? LINKS_FIELD : name)),
          ...extra,
        ]),
      ].join(",")
    : [VIEW_FIELDS, ...extra].join(",");
  const payload = await acliJson<unknown>([
    "jira",
    "workitem",
    "view",
    key,
    "--fields",
    requested,
    "--json",
  ]);
  const item = Array.isArray(payload) ? payload[0] : payload;
  if (!item || typeof item !== "object") {
    throw new AxiError(`Work item not found: ${key}`, "NOT_FOUND");
  }
  return item as JsonRecord;
}

async function runSearch(
  jql: string,
  limit: number,
  fields: string[] | undefined,
): Promise<JsonRecord[]> {
  const acliArgs = [
    "jira",
    "workitem",
    "search",
    "--jql",
    jql,
    "--limit",
    String(limit),
    "--json",
  ];
  if (fields) {
    acliArgs.push("--fields", fields.join(","));
  }
  const payload = await acliJson<unknown>(acliArgs);
  return itemsOf(payload, "issues", "workItems", "results", "values");
}

function renderSearchResults(
  action: "list" | "search",
  items: JsonRecord[],
  limit: number,
  fields: string[] | undefined,
  ctx?: SiteContext,
  emptyScope?: string,
): string {
  const schema = fields ? fieldsSchema(fields) : workitemListSchema;
  const blocks: string[] = [
    formatCountLine({ count: items.length, limit }),
  ];
  // A bare `count: 0` cannot be told apart from "nothing exists" when the CLI
  // injected a filter the caller never typed - disclose that scope so the
  // agent does not re-run with a broader query just to find out.
  if (items.length === 0 && emptyScope) {
    blocks.push(`scope: ${emptyScope}`);
  }
  if (items.length > 0) {
    blocks.push(renderList("workitems", items, schema));
  }
  blocks.push(
    renderHelp(
      getSuggestions({
        domain: "workitem",
        action,
        isEmpty: items.length === 0,
        site: ctx,
      }),
    ),
  );
  return renderOutput(blocks);
}

// ---------------------------------------------------------------------------
// list / search
// ---------------------------------------------------------------------------

async function listWorkitems(
  args: string[],
  ctx?: SiteContext,
): Promise<string> {
  const parsed = parseFlags(args, {
    values: [
      "--jql",
      "--project",
      "--assignee",
      "--status",
      "--limit",
      "--fields",
    ],
  });
  if (parsed.help) return workitemHelp("list");

  const jqlFlag = parsed.values["--jql"];
  const project = parsed.values["--project"];
  const assignee = parsed.values["--assignee"];
  const status = parsed.values["--status"];
  const limit = parseLimit(parsed.values["--limit"]);
  const fields = splitFields(parsed.values["--fields"]);

  if (jqlFlag && (project || assignee || status)) {
    throw new AxiError(
      "Use either --jql or the --project/--assignee/--status filters, not both",
      "VALIDATION_ERROR",
    );
  }

  const jql = jqlFlag ?? buildJql({ project, assignee, status });
  const items = await runSearch(jql, limit, fields);
  // Derived from the JQL actually built, not from a copy of buildJql's branch
  // condition: a filter added there later must not leave this claiming the
  // default window while the caller's own filter was applied.
  const usedDefaultWindow = !jqlFlag && jql === DEFAULT_WINDOW_JQL;
  return renderSearchResults(
    "list",
    items,
    limit,
    fields,
    ctx,
    usedDefaultWindow
      ? `${DEFAULT_WINDOW_CLAUSE} (default recency window - pass --jql "<JQL>" or --project <KEY> to widen)`
      : undefined,
  );
}

// acli rejects unbounded JQL ("Unbounded JQL queries are not allowed"), so a
// bare `list` gets a recency window instead of an unrestricted query.
const DEFAULT_WINDOW_CLAUSE = "updated >= -30d";
const DEFAULT_WINDOW_JQL = `${DEFAULT_WINDOW_CLAUSE} ORDER BY updated DESC`;

function buildJql(filters: {
  project?: string;
  assignee?: string;
  status?: string;
}): string {
  const clauses: string[] = [];
  if (filters.project) {
    clauses.push(`project = ${quoteJql(filters.project)}`);
  }
  if (filters.assignee) {
    clauses.push(
      filters.assignee === "@me"
        ? "assignee = currentUser()"
        : `assignee = ${quoteJql(filters.assignee)}`,
    );
  }
  if (filters.status) {
    clauses.push(`status = ${quoteJql(filters.status)}`);
  }
  const where = clauses.join(" AND ");
  return where ? `${where} ORDER BY updated DESC` : DEFAULT_WINDOW_JQL;
}

async function searchWorkitems(
  args: string[],
  ctx?: SiteContext,
): Promise<string> {
  const parsed = parseFlags(args, { values: ["--limit", "--fields"] });
  if (parsed.help) return workitemHelp("search");

  const jql = parsed.positional;
  if (!jql) {
    throw new AxiError("Missing JQL query", "VALIDATION_ERROR", [
      'Run `jira-axi workitem search "<JQL>"`',
    ]);
  }
  // An unquoted JQL (`workitem search project = TEAM`) would search only its
  // first token and return wrong results at exit 0 - reject the leftover.
  rejectExtraPositional(
    args,
    'Quote the whole JQL as one argument: jira-axi workitem search "<JQL>"',
  );
  const limit = parseLimit(parsed.values["--limit"]);
  const fields = splitFields(parsed.values["--fields"]);
  const items = await runSearch(jql, limit, fields);
  return renderSearchResults("search", items, limit, fields, ctx);
}

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

async function viewWorkitem(
  args: string[],
  ctx?: SiteContext,
): Promise<string> {
  const parsed = parseFlags(args, {
    values: ["--fields", "--limit"],
    bools: ["--full", "--comments", "--links"],
  });
  if (parsed.help) return workitemHelp("view");

  const key = requireKey(args, parsed.positional, "view");
  const full = parsed.bools["--full"];
  const withComments = parsed.bools["--comments"];
  const withLinks = parsed.bools["--links"];
  // `view` has two nested collections (comments, links); --limit governs
  // whichever were asked for, and is meaningless without either.
  const listLimit = parseLimit(parsed.values["--limit"]);
  if (parsed.values["--limit"] !== undefined && !withComments && !withLinks) {
    throw new AxiError(
      "--limit only applies to the comments and links lists (pass --comments or --links)",
      "VALIDATION_ERROR",
      ["Run `jira-axi workitem view <KEY> --comments --limit <n>`"],
    );
  }
  const fields = splitFields(parsed.values["--fields"]);

  // --full governs body truncation in the DEFAULT schema; a --fields render
  // never truncates, so the combination would be a silent no-op — reject it.
  if (fields && full) {
    throw new AxiError(
      "--full cannot be combined with --fields (a --fields render is never truncated)",
      "VALIDATION_ERROR",
      ["Drop --full, or drop --fields to render the default field set"],
    );
  }

  // `comment` rides along with --comments: the embedded field is the STORED
  // ADF (mentions, lists and marks intact), where acli's `comment list`
  // flattens it lossily and drops every mention.
  const item = await fetchWorkitem(key, fields, [
    ...(withLinks ? [LINKS_FIELD] : []),
    ...(withComments ? ["comment"] : []),
  ]);
  const links = linksOf(item);
  const blocks: string[] = [
    renderDetail(
      "workitem",
      item,
      fields
        ? fieldsSchema(fields)
        : // With --links the rows follow below, so the detail row is the bare
          // count instead of repeating them as an inline summary.
          workitemViewSchema(full, { linksAsCount: withLinks }),
    ),
  ];

  // Mirror sprint list-workitems: surface --fields values acli did not
  // return, so a `bogus: null` row is never mistaken for an empty field.
  // `parent` is exempt: it is a real field that Jira simply omits when an item
  // is top-level, so its absence is a meaningful state (rendered "none" by the
  // schema below), NOT an unreturned/unknown field. Flagging it as "unknown
  // field name" is what made an orphaned item look uninspectable. Note this
  // exemption is only possible for KNOWN fields: acli silently omits an unknown
  // field the same way it omits an empty one, so in general an unreadable field
  // is indistinguishable from an absent one - an inherent acli limit, which is
  // why the note exists at all for the fields we cannot special-case.
  if (fields) {
    const nested = item.fields;
    // `links` is this CLI's alias: what acli returns it under is `issuelinks`.
    const returnedAs = (name: string) =>
      name === LINKS_ALIAS ? LINKS_FIELD : name;
    const dropped = fields.filter(
      (name) =>
        name !== "key" &&
        name !== "parent" &&
        !(
          nested &&
          typeof nested === "object" &&
          returnedAs(name) in nested
        ) &&
        !(returnedAs(name) in item),
    );
    if (dropped.length > 0) {
      blocks.push(
        `note: acli did not return field(s) ${dropped.join(", ")} (unknown field name, or unsupported by workitem view)`,
      );
    }
  }

  if (withLinks) {
    // Rendered from the payload already in hand - no second acli call. An
    // unreturned field is said so, never rendered as "0 links".
    blocks.push(
      ...(links === undefined
        ? [`links: unknown (acli did not return \`${LINKS_FIELD}\` for ${key})`]
        : renderLinkList(key, links, listLimit)),
    );
  }

  if (withComments) {
    const { comments, total } = await readComments(key, item, listLimit);
    blocks.push(
      formatCountLine({
        count: comments.length,
        limit: listLimit,
        ...(total !== undefined ? { totalCount: total } : {}),
      }),
    );
    if (comments.length > 0) {
      blocks.push(renderList("comments", comments, commentSchema(full)));
    } else {
      blocks.push("comments: none");
    }
  }

  blocks.push(
    renderHelp(
      getSuggestions({
        domain: "workitem",
        action: "view",
        id: key,
        // Point at the link rows only when there are links this render did not
        // already list.
        state:
          !withLinks && links !== undefined && links.length > 0
            ? "has-links"
            : undefined,
        site: ctx,
      }),
    ),
  );
  return renderOutput(blocks);
}

/**
 * The first `limit` comments of a work item, oldest first, plus the true total.
 *
 * Preferred source: the `comment` field already embedded in `item` (stored ADF,
 * so mentions render as `@Name`). When acli did not return it, or returned
 * fewer rows than were asked for, fall back to acli's server-paged
 * `comment list` - complete, but flattened upstream (no mentions, no marks).
 */
async function readComments(
  key: string,
  item: JsonRecord,
  limit: number,
): Promise<{ comments: JsonRecord[]; total: number | undefined }> {
  const embedded = fieldOf(item, "comment");
  if (embedded && typeof embedded === "object") {
    const all = commentsOf(item);
    const total = totalOf(embedded) ?? all.length;
    if (all.length >= Math.min(limit, total)) {
      return { comments: all.slice(0, limit), total };
    }
  }
  // acli's comment list defaults to a 50-row page and its envelope carries
  // the true `total`; without an explicit --limit and a count line the
  // truncation was silent (an issue with 200 comments rendered 50 rows with
  // no signal that 150 more existed).
  const payload = await acliJson<unknown>([
    "jira",
    "workitem",
    "comment",
    "list",
    "--key",
    key,
    "--limit",
    String(limit),
    "--json",
  ]);
  return {
    comments: itemsOf(payload, "comments", "values"),
    total: totalOf(payload),
  };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

async function createWorkitem(
  args: string[],
  ctx?: SiteContext,
): Promise<string> {
  // valueBoundaryFlags keeps `--body --summary "..."` from swallowing the
  // sibling flag as the description text.
  const body = takeBody(args, {
    valueBoundaryFlags: [
      "--project",
      "--type",
      "--summary",
      "--assignee",
      "--label",
      "--parent",
    ],
  });
  const parsed = parseFlags(args, {
    values: [
      "--project",
      "--type",
      "--summary",
      "--assignee",
      "--label",
      "--parent",
    ],
    consumed: BODY_FLAGS,
  });
  if (parsed.help) return workitemHelp("create");

  const project = parsed.values["--project"];
  const type = parsed.values["--type"];
  const summary = parsed.values["--summary"];
  const assignee = parsed.values["--assignee"];
  const label = parsed.values["--label"];
  // Parent is a work-item key (the epic/story this item belongs under). Reject a
  // malformed value up front rather than after a network round-trip, mirroring
  // requireKey's shape check. acli owns the semantics (a non-existent or
  // wrong-hierarchy parent surfaces as an acli error). Test PRESENCE, not
  // truthiness: `--parent ""` (e.g. `--parent "$EPIC"` with the var unset) must
  // be a loud error, not a silent drop back to a top-level item - the very
  // incident this flag exists to prevent.
  const rawParent = parsed.values["--parent"];
  const parent = rawParent?.toUpperCase();
  if (rawParent !== undefined && !WORKITEM_KEY.test(parent as string)) {
    throw new AxiError(
      `Invalid --parent: ${JSON.stringify(rawParent)} (expected a work-item key, e.g. TEAM-1)`,
      "VALIDATION_ERROR",
      ['Run `jira-axi workitem create ... --parent <KEY>`'],
    );
  }

  const missing = [
    !project ? "--project" : null,
    !type ? "--type" : null,
    !summary ? "--summary" : null,
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new AxiError(
      `Missing required flags: ${missing.join(", ")}`,
      "VALIDATION_ERROR",
      [
        'Run `jira-axi workitem create --project <KEY> --type Task --summary "..."`',
      ],
    );
  }

  const acliArgs = [
    "jira",
    "workitem",
    "create",
    "--project",
    project as string,
    "--type",
    type as string,
    "--summary",
    summary as string,
    "--json",
  ];
  // Descriptions are ADF: convert the markdown body to a proper ADF document and
  // feed it through acli's --description-file ADF path (a bare --description
  // string is stored as one flat text node, so markdown renders literally).
  const description = body ? writeAdfTempFile(body) : undefined;
  if (description) acliArgs.push("--description-file", description.path);
  if (assignee) acliArgs.push("--assignee", assignee);
  if (label) acliArgs.push("--label", label);
  if (parent) acliArgs.push("--parent", parent);

  let created: unknown;
  try {
    created = await acliJson<unknown>(acliArgs);
  } finally {
    description?.cleanup();
  }
  const key = firstKeyOf(created);

  if (!key) {
    // Shape drifted; still report success with whatever acli returned.
    return renderOutput([
      renderDetail(
        "workitem",
        { _message: "Created (key not detected in acli output)" },
        [field("_message", "message")],
      ),
    ]);
  }

  const item = await fetchWorkitem(key);
  // The authoritative post-state carries the parent (VIEW_FIELDS requests it).
  // When it came back empty the item is top-level; surface that as suggestion
  // state so `create` can point at --parent - the omission that made the
  // original incident silent. Computed from the re-fetched item, not the flag,
  // so it reflects what Jira actually stored. An Epic sits at the top of the
  // hierarchy and has no parent by design, so it is never "orphaned".
  const createdType = nameOf(fieldOf(item, "issuetype"));
  const orphan =
    nameOf(fieldOf(item, "parent")) === null &&
    createdType?.toLowerCase() !== "epic";
  return renderOutput([
    renderDetail("workitem", item, workitemViewSchema(false)),
    renderHelp(
      getSuggestions({
        domain: "workitem",
        action: "create",
        id: key,
        state: orphan ? "orphan" : "parented",
        site: ctx,
      }),
    ),
  ]);
}

/** Find the created work item key in a tolerant way (shape is undocumented). */
function firstKeyOf(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const key = firstKeyOf(entry);
      if (key) return key;
    }
    return undefined;
  }
  const record = payload as JsonRecord;
  if (typeof record.key === "string" && record.key.includes("-")) {
    return record.key;
  }
  for (const nested of ["workitem", "issue", "issues", "workItems"]) {
    if (record[nested]) {
      const key = firstKeyOf(record[nested]);
      if (key) return key;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

async function editWorkitem(
  args: string[],
  ctx?: SiteContext,
): Promise<string> {
  // valueBoundaryFlags keeps `--body --summary "..."` from swallowing the
  // sibling flag as the description text.
  const body = takeBody(args, {
    valueBoundaryFlags: [
      "--summary",
      "--assignee",
      "--type",
      "--labels",
      "--remove-labels",
    ],
  });
  const parsed = parseFlags(args, {
    values: [
      "--summary",
      "--assignee",
      "--type",
      "--labels",
      "--remove-labels",
    ],
    consumed: BODY_FLAGS,
  });
  if (parsed.help) return workitemHelp("edit");

  const key = requireKey(args, parsed.positional, "edit");
  const summary = parsed.values["--summary"];
  const assignee = parsed.values["--assignee"];
  const type = parsed.values["--type"];
  const labels = parsed.values["--labels"];
  const removeLabels = parsed.values["--remove-labels"];

  const acliArgs = ["jira", "workitem", "edit", "--key", key, "--yes", "--json"];
  let hasChanges = false;
  const pushChange = (flag: string, value: string | undefined) => {
    if (value) {
      acliArgs.push(flag, value);
      hasChanges = true;
    }
  };
  pushChange("--summary", summary);
  pushChange("--assignee", assignee);
  pushChange("--type", type);
  pushChange("--labels", labels);
  pushChange("--remove-labels", removeLabels);
  // Descriptions are ADF: convert the markdown body and pass it via the ADF
  // --description-file path rather than a flat --description string.
  const description = body ? writeAdfTempFile(body) : undefined;
  if (description) {
    acliArgs.push("--description-file", description.path);
    hasChanges = true;
  }

  if (!hasChanges) {
    description?.cleanup();
    throw new AxiError("No changes specified", "VALIDATION_ERROR", [
      'Pass at least one of --summary, --body/--body-file, --assignee, --type, --labels, --remove-labels',
    ]);
  }

  try {
    await acliJson<unknown>(acliArgs);
  } finally {
    description?.cleanup();
  }

  const item = await fetchWorkitem(key);
  return renderOutput([
    renderDetail("workitem", item, workitemViewSchema(false)),
    renderHelp(
      getSuggestions({ domain: "workitem", action: "edit", id: key, site: ctx }),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// transition
// ---------------------------------------------------------------------------

async function transitionWorkitem(
  args: string[],
  ctx?: SiteContext,
): Promise<string> {
  const parsed = parseFlags(args, { values: ["--to"] });
  if (parsed.help) return workitemHelp("transition");

  const key = requireKey(args, parsed.positional, "transition");
  const to = parsed.values["--to"];
  if (!to) {
    throw new AxiError("Missing --to <status>", "VALIDATION_ERROR", [
      "Run `jira-axi workitem transition <KEY> --to <status>`",
    ]);
  }

  // Idempotent: a transition to the current status is a no-op success.
  const current = await fetchWorkitem(key);
  const currentStatus = nameOf(fieldOf(current, "status"));
  if (currentStatus && currentStatus.toLowerCase() === to.toLowerCase()) {
    return renderOutput([
      renderDetail(
        "workitem",
        { ...current, _message: `Already ${currentStatus}` },
        [...statusResultSchema(), field("_message", "message")],
      ),
      renderHelp(
        getSuggestions({
          domain: "workitem",
          action: "transition",
          id: key,
          site: ctx,
        }),
      ),
    ]);
  }

  await acliJson<unknown>([
    "jira",
    "workitem",
    "transition",
    "--key",
    key,
    "--status",
    to,
    "--yes",
    "--json",
  ]);

  const item = await fetchWorkitem(key);
  return renderOutput([
    renderDetail("workitem", item, statusResultSchema()),
    renderHelp(
      getSuggestions({
        domain: "workitem",
        action: "transition",
        id: key,
        site: ctx,
      }),
    ),
  ]);
}

function statusResultSchema() {
  return workitemViewSchema(false).filter((def) =>
    ["key", "summary", "status", "assignee"].includes(
      "as" in def ? (def.as ?? "") : "",
    ),
  );
}

// ---------------------------------------------------------------------------
// assign
// ---------------------------------------------------------------------------

async function assignWorkitem(
  args: string[],
  ctx?: SiteContext,
): Promise<string> {
  const parsed = parseFlags(args, { values: ["--assignee"] });
  if (parsed.help) return workitemHelp("assign");

  const key = requireKey(args, parsed.positional, "assign");
  const assignee = parsed.values["--assignee"];
  if (!assignee) {
    throw new AxiError("Missing --assignee <email|@me>", "VALIDATION_ERROR", [
      "Run `jira-axi workitem assign <KEY> --assignee <email|@me>`",
    ]);
  }

  // Idempotent: skip the mutation when the target user is already assigned.
  // '@me'/'default' resolve server-side, so those always go through acli.
  const current = await fetchWorkitem(key);
  if (isAlreadyAssigned(current, assignee)) {
    const name = nameOf(fieldOf(current, "assignee"));
    return renderOutput([
      renderDetail(
        "workitem",
        { ...current, _message: `Already assigned to ${name}` },
        [...statusResultSchema(), field("_message", "message")],
      ),
      renderHelp(
        getSuggestions({
          domain: "workitem",
          action: "assign",
          id: key,
          site: ctx,
        }),
      ),
    ]);
  }

  await acliJson<unknown>([
    "jira",
    "workitem",
    "assign",
    "--key",
    key,
    "--assignee",
    assignee,
    "--yes",
    "--json",
  ]);

  const item = await fetchWorkitem(key);
  return renderOutput([
    renderDetail("workitem", item, statusResultSchema()),
    renderHelp(
      getSuggestions({
        domain: "workitem",
        action: "assign",
        id: key,
        site: ctx,
      }),
    ),
  ]);
}

function isAlreadyAssigned(item: JsonRecord, requested: string): boolean {
  if (requested === "@me" || requested === "default") return false;
  const assignee = fieldOf(item, "assignee");
  if (!assignee || typeof assignee !== "object") return false;
  const record = assignee as JsonRecord;
  const wanted = requested.toLowerCase();
  return [record.emailAddress, record.displayName, record.accountId].some(
    (candidate) =>
      typeof candidate === "string" && candidate.toLowerCase() === wanted,
  );
}

// ---------------------------------------------------------------------------
// comment
// ---------------------------------------------------------------------------

/** Fields that name the people on a ticket (plus the comments already there). */
const PEOPLE_FIELDS = ["assignee", "reporter", "comment", "description"];

/** Longest inline body an error's retry command reprints verbatim. */
const RETRY_BODY_MAX = 300;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the retry instruction for a comment: the same command, optionally with
 * one mention token swapped and/or `--mention` added. An inline one-line body
 * is reprinted verbatim so the command runs as printed; a file or a long body
 * cannot be, so the instruction names the edit instead.
 */
function commentRetry(
  key: string,
  args: readonly string[],
  body: string,
  withMention: boolean,
): (replace?: { from: string; to: string }) => string {
  const fileIndex = args.findIndex(
    (arg) => arg === "--body-file" || arg.startsWith("--body-file="),
  );
  const file =
    fileIndex === -1
      ? undefined
      : args[fileIndex].includes("=")
        ? args[fileIndex].slice("--body-file=".length)
        : args[fileIndex + 1];
  const tail = withMention ? " --mention" : "";
  return (replace) => {
    if (file !== undefined) {
      const command = `jira-axi workitem comment ${key} --body-file ${shellQuote(file)}${tail}`;
      return replace
        ? `Replace ${replace.from} with ${replace.to} in ${file}, then run \`${command}\``
        : `Run \`${command}\``;
    }
    if (body.length > RETRY_BODY_MAX || /[\r\n`]/.test(body)) {
      const command = `jira-axi workitem comment ${key} --body "<same body>"${tail}`;
      return replace
        ? `Replace ${replace.from} with ${replace.to} in the body, then run \`${command}\``
        : `Run \`${command}\``;
    }
    // Match the token as typed: any case, any padding inside the brackets.
    const next = replace
      ? body.replace(
          new RegExp(
            `@\\[\\s*${replace.from.slice(2, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\]`,
            "gi",
          ),
          () => replace.to,
        )
      : body;
    return `Run \`jira-axi workitem comment ${key} --body ${shellQuote(next)}${tail}\``;
  };
}

const searchPeople: PeopleSearch = (field, query, exclude, limit) =>
  runSearch(
    `${field} = ${quoteJql(query)}${
      exclude.length > 0
        ? ` AND ${field} not in (${exclude.map(quoteJql).join(", ")})`
        : ""
    } ORDER BY updated DESC`,
    limit,
    ["key", field],
  );

/** Watchers are one more place a name can resolve from; never worth failing on. */
async function fetchWatchers(key: string): Promise<unknown> {
  try {
    return await acliJson<unknown>([
      "jira",
      "workitem",
      "list-watchers",
      "--key",
      key,
      "--json",
    ]);
  } catch {
    return undefined;
  }
}

async function commentWorkitem(
  args: string[],
  ctx?: SiteContext,
): Promise<string> {
  const rawArgs = [...args];
  // Optional at first so `comment --help` reaches the help path; enforced below.
  // valueBoundaryFlags keeps `--body --mention` from posting the text "--mention".
  const body = takeBody(args, {
    label: "comment",
    valueBoundaryFlags: ["--mention"],
  });
  const parsed = parseFlags(args, {
    bools: ["--mention"],
    consumed: BODY_FLAGS,
  });
  if (parsed.help) return workitemHelp("comment");

  if (body === undefined) {
    throw new AxiError("--body or --body-file is required", "VALIDATION_ERROR", [
      'Use --body "..." for inline comment, or --body-file <path> for markdown from a file',
    ]);
  }
  const key = requireKey(args, parsed.positional, "comment");
  const confirmed = parsed.bools["--mention"];

  // Comment bodies are ADF too: convert the markdown and pass it through acli's
  // ADF --body-file path (a bare --body string stores one flat text node).
  // `@[...]` becomes an unresolved mention node, resolved (or refused) below
  // BEFORE anything is written.
  const doc = bodyToAdf(body, { mentions: true });
  const requests = mentionRequests(doc);
  let expected: Person[] = [];
  let existingIds = new Set<string>();
  // Jira embeds only the FIRST page of the `comment` field (100, oldest first;
  // seen live on a 1641-comment item), so on a long thread the comment posted
  // below can never be re-read through it - and acli has no other ADF read.
  let embeddedIsPaged = false;

  if (requests.length > 0) {
    if (requests.length > MAX_MENTIONS) {
      throw new AxiError(
        `Too many mentions: this comment has ${requests.length} different @[...] mentions and the limit is ${MAX_MENTIONS} per comment. Nothing was posted to ${key}`,
        "VALIDATION_ERROR",
        [
          `Keep at most ${MAX_MENTIONS} @[...] mentions (write the rest as plain names), or split the comment`,
        ],
      );
    }
    const before = await fetchWorkitem(key, PEOPLE_FIELDS);
    const people = peopleOnTicket(
      before,
      // An account id needs no lookup, so it does not pay for the watcher read.
      requests.some((request) => request.kind !== "account")
        ? await fetchWatchers(key)
        : undefined,
    );
    const resolved = await resolveMentions(
      key,
      requests,
      people,
      searchPeople,
      commentRetry(key, rawArgs, body, confirmed),
    );
    expected = distinctPeople(resolved);

    // The guard: a mention notifies people and cannot be undone, so the first
    // run is only ever the preview.
    if (!confirmed) {
      throw new AxiError(
        `Refusing to post without --mention. Nothing was posted to ${key}. This comment would notify ${expected.length} ${expected.length === 1 ? "person" : "people"}: ${expected.map(describePerson).join("; ")}`,
        "VALIDATION_ERROR",
        [
          `${commentRetry(key, rawArgs, body, true)()} to post it and notify them`,
          "To post without notifying anyone, write the names as plain text (no @[...])",
        ],
      );
    }
    const existing = commentsOf(before);
    existingIds = new Set(existing.map((c) => String(c.id)));
    embeddedIsPaged =
      (totalOf(fieldOf(before, "comment")) ?? 0) > existing.length;
  }

  const comment = writeAdfDocTempFile(doc);
  try {
    await acliJson<unknown>([
      "jira",
      "workitem",
      "comment",
      "create",
      "--key",
      key,
      "--body-file",
      comment.path,
      "--json",
    ]);
  } finally {
    comment.cleanup();
  }

  // The post-state read doubles as the mention check and the source for the
  // bare-@Name note, so the comments ride along only when one of them needs it.
  const needsPeople = expected.length > 0 || body.includes("@");
  const item = await fetchWorkitem(
    key,
    undefined,
    needsPeople ? ["reporter", "comment"] : [],
  );

  const blocks: string[] = [];
  let message = "Comment added";
  if (expected.length > 0) {
    const stored = storedCommentOf(item, existingIds, expected);
    if (!stored) {
      const why = embeddedIsPaged
        ? `${key} has more comments than acli returns in the comment field (only the first ${existingIds.size}, oldest first), so the new comment is not in the re-read and its mentions cannot be confirmed through acli`
        : "acli returned no new comment in the ticket's comment field";
      throw new AxiError(
        `Comment was posted to ${key} but could not be re-read, so its mentions are NOT confirmed (${why}). Do not re-run: that would post it twice`,
        "UNKNOWN",
        embeddedIsPaged
          ? []
          : [
              `Run \`jira-axi workitem view ${key} --comments --full --limit 200\` to read the stored comment`,
            ],
      );
    }
    const mentions = storedMentions(stored.body);
    const missing = expected.filter(
      (person) => !mentions.some((m) => m.accountId === person.accountId),
    );
    if (missing.length > 0) {
      throw new AxiError(
        `Comment ${stored.id} was posted to ${key} but the STORED comment does not mention: ${missing.map(describePerson).join("; ")}. They were NOT notified by it. Do not re-run: that would post it twice`,
        "UNKNOWN",
        [
          `Run \`jira-axi workitem view ${key} --comments --full --limit 200\` to read the stored comment`,
        ],
      );
    }
    message = `Comment added (id ${stored.id}); mentions confirmed in the stored comment`;
    blocks.push(
      renderList("mentions", mentions, [
        custom("name", (m: StoredMention) => m.name ?? "unknown"),
        custom("account", (m: StoredMention) => m.accountId),
      ]),
    );
  } else if (confirmed) {
    blocks.push("mentions: none (the body has no @[...] mention, so nobody was notified)");
  }

  const note = needsPeople
    ? bareMentionNote(doc, peopleOnTicket(item))
    : undefined;
  if (note) blocks.push(note);

  return renderOutput([
    renderDetail("workitem", { ...item, _message: message }, [
      ...statusResultSchema(),
      field("_message", "message"),
    ]),
    ...blocks,
    renderHelp(
      getSuggestions({
        domain: "workitem",
        action: "comment",
        id: key,
        site: ctx,
      }),
    ),
  ]);
}

/**
 * The comment this command just posted, found in the post-state as a comment
 * id that was not there before. If someone else commented in the same instant,
 * prefer the one carrying the expected mentions.
 */
function storedCommentOf(
  item: JsonRecord,
  existingIds: Set<string>,
  expected: Person[],
): JsonRecord | undefined {
  const fresh = commentsOf(item).filter(
    (c) => c.id !== undefined && !existingIds.has(String(c.id)),
  );
  const complete = fresh.filter((c) => {
    const mentions = storedMentions(c.body);
    return expected.every((p) => mentions.some((m) => m.accountId === p.accountId));
  });
  return complete[complete.length - 1] ?? fresh[fresh.length - 1];
}
