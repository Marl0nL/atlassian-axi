import { custom, extract, relativeTime, type FieldDef } from "@atlassian-axi/core";
import { truncateBody } from "@atlassian-axi/core";
import { AxiError } from "@atlassian-axi/core";

// Domain-agnostic plumbing lives in commands/shared.ts (also used by the
// Confluence half); re-exported so jira modules keep one import site.
export {
  parseFlags,
  parseLimit,
  // The --fields split is domain-agnostic and now lives in core so both CLIs
  // parse the escape hatch identically; re-exported for the existing call sites.
  splitFields,
  type ParsedFlags,
} from "@atlassian-axi/core";

/**
 * Shared tolerant accessors + FieldDef schemas for the acli-backed Jira half.
 *
 * acli's --json shape is an external, undocumented contract (scout report risk
 * R3): payloads mirror the Jira Cloud REST v3 issue shape (`key` at top level,
 * everything else under `fields`), but every accessor here also tolerates a
 * flattened shape so a drift in acli output degrades to nulls instead of
 * crashes. Fixtures in test/fixtures/acli.ts pin the expected shape.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- payloads are JSON-parsed with dynamic keys
export type JsonRecord = Record<string, any>;

/** Read a Jira field: nested `item.fields[name]` first, then flat `item[name]`. */
export function fieldOf(item: JsonRecord, name: string): unknown {
  const fields = item?.fields;
  const nested =
    fields && typeof fields === "object"
      ? (fields as JsonRecord)[name]
      : undefined;
  return nested ?? item?.[name];
}

/** Collapse Jira's named-object values ({name}/{displayName}/{key}) to a string. */
export function nameOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    const record = value as JsonRecord;
    const name = record.name ?? record.displayName ?? record.key;
    return typeof name === "string" ? name : null;
  }
  return typeof value === "string" ? value : String(value);
}

/**
 * Neutralize non-printing control characters in remote-derived strings before
 * they reach the terminal. TOON escapes C0 controls (incl. ESC/CR/BEL) but
 * lets the C1 range through, so a work-item summary/description/comment
 * carrying U+009B (8-bit CSI) or U+0080-U+009F could drive terminals that
 * honour 8-bit controls — a terminal-escape injection from attacker-influenced
 * Jira content. Strip C1 (0x80-0x9F) and DEL (0x7F); C0 is left to TOON's own
 * escaping. Mirrors confluence-axi's stripControlChars (review finding F6).
 */
export function stripControlChars(text: string): string {
  return text.replace(/[\u007f-\u009f]/g, "");
}

/**
 * Flatten an Atlassian Document Format (ADF) document to plain text. Jira
 * descriptions/comments arrive as ADF objects from the REST shape; plain-text
 * strings pass through untouched. Remote text is stripped of C1/DEL controls
 * (see stripControlChars) so a crafted body cannot smuggle a terminal-escape.
 */
export function textOf(value: unknown): string {
  if (typeof value === "string") return stripControlChars(value);
  if (!value || typeof value !== "object") return "";
  const parts: string[] = [];
  walkAdf(value as JsonRecord, parts);
  return stripControlChars(parts.join(""));
}

function walkAdf(node: JsonRecord, parts: string[]): void {
  if (typeof node.text === "string") {
    parts.push(node.text);
  }
  const content = node.content;
  if (Array.isArray(content)) {
    for (const child of content) {
      if (child && typeof child === "object") {
        walkAdf(child as JsonRecord, parts);
      }
    }
    // Every block-level node ends its own line; without codeBlock/listItem
    // here a fenced block ran straight into the next paragraph
    // ("const x = 42;Link to Atlassian" — sweep finding 2026-07-19).
    // Dedupe at push time (listItem wraps paragraph, both terminate) — a
    // global \n{2,} collapse would also destroy literal blank lines inside
    // codeBlock text (review finding 2026-07-19).
    if (
      node.type === "paragraph" ||
      node.type === "heading" ||
      node.type === "codeBlock" ||
      node.type === "listItem"
    ) {
      const last = parts[parts.length - 1];
      if (last === undefined || !last.endsWith("\n")) {
        parts.push("\n");
      }
    }
  }
}

/**
 * Baseline truncation length for every free-text field in this CLI (workitem
 * body, comment body, filter/project description). One constant so the
 * truncation stays uniform, per the AXI 500-1500 floor.
 */
export const BODY_TRUNCATE_LENGTH = 500;

interface TruncatedTextFieldOptions {
  /** Command-specific escape hatch named in the truncation marker. */
  fullHint?: string;
  /** Placeholder for a blank field, where the call site renders one. */
  emptyValue?: string;
}

/**
 * Build the one truncated free-text FieldDef every body/description column
 * uses. Truncation is engine-owned (`truncateBody`); call sites supply only
 * how to read their text and how their own --full flag is spelled.
 */
export function truncatedTextField(
  name: string,
  getText: (item: JsonRecord) => string,
  full: boolean,
  options: TruncatedTextFieldOptions = {},
): FieldDef {
  return custom(name, (item: JsonRecord) => {
    const text = getText(item);
    if (!text && options.emptyValue !== undefined) return options.emptyValue;
    if (full) return text;
    return truncateBody(
      text,
      BODY_TRUNCATE_LENGTH,
      options.fullHint !== undefined ? { fullHint: options.fullHint } : {},
    );
  });
}

/** Short status enum keeps list output token-lean; unknown statuses lowercase. */
export function shortStatus(item: JsonRecord): string {
  const name = nameOf(fieldOf(item, "status"));
  if (!name) return "unknown";
  const map: Record<string, string> = {
    "to do": "todo",
    "in progress": "wip",
    "in review": "review",
    done: "done",
    backlog: "backlog",
    "selected for development": "selected",
  };
  return map[name.toLowerCase()] ?? name.toLowerCase();
}

function assigneeOf(item: JsonRecord): string {
  return nameOf(fieldOf(item, "assignee")) ?? "unassigned";
}

/**
 * Work-item summary, stripped of C1/DEL controls. The summary is
 * attacker-influenced remote text (anyone who can create/edit a ticket sets
 * it), so neutralize a crafted 8-bit terminal-escape before it reaches the
 * terminal — mirrors confluence-axi's title handling (review finding F6).
 */
function summaryOf(item: JsonRecord): string | null {
  const summary = nameOf(fieldOf(item, "summary"));
  return summary === null ? null : stripControlChars(summary);
}

/**
 * List schema: key, summary, short status, assignee. No `updated` column:
 * acli's search --fields whitelist rejects `updated` (verified live against
 * v1.3.22: "field 'updated' is not allowed"), so search payloads can never
 * carry it. `view` fetches it explicitly instead.
 */
export const workitemListSchema: FieldDef[] = [
  custom("key", (item: JsonRecord) => item.key ?? null),
  custom("summary", summaryOf),
  custom("status", shortStatus),
  custom("assignee", assigneeOf),
];

/** Compact schema for the home dashboard's my-open-workitems block. */
export const workitemDashboardSchema: FieldDef[] = [
  custom("key", (item: JsonRecord) => item.key ?? null),
  custom("summary", summaryOf),
  custom("status", shortStatus),
];

/**
 * Detail schema for `view`; body truncated unless --full. `linksAsCount`
 * renders the `links` row as the bare count (for `view --links`, where the
 * rows themselves follow).
 */
export function workitemViewSchema(
  full: boolean,
  options: { linksAsCount?: boolean } = {},
): FieldDef[] {
  return [
    custom("key", (item: JsonRecord) => item.key ?? null),
    custom("summary", summaryOf),
    custom("type", (item: JsonRecord) => nameOf(fieldOf(item, "issuetype"))),
    custom("status", (item: JsonRecord) =>
      nameOf(fieldOf(item, "status"))?.toLowerCase() ?? "unknown",
    ),
    custom("assignee", assigneeOf),
    // Epic/parent membership. Renders the parent key when present, an explicit
    // "none" when the item is top-level - so an item created outside its
    // intended epic is legible at a glance instead of being an absent field
    // that no one notices (the failure mode behind the --parent gap).
    custom("parent", (item: JsonRecord) => nameOf(fieldOf(item, "parent")) ?? "none"),
    // Work-item links, as a count plus a capped inline summary, so an agent
    // reading a ticket sees its links without a second call (`--links` or
    // `list-links` render the full rows).
    custom("links", (item: JsonRecord) =>
      options.linksAsCount
        ? (linksOf(item)?.length ?? "unknown")
        : linksSummaryOf(item),
    ),
    custom("priority", (item: JsonRecord) =>
      nameOf(fieldOf(item, "priority")),
    ),
    custom("created", (item: JsonRecord) =>
      relativeOf(item, "created"),
    ),
    custom("updated", (item: JsonRecord) =>
      relativeOf(item, "updated"),
    ),
    truncatedTextField(
      "body",
      (item: JsonRecord) => textOf(fieldOf(item, "description")).trim(),
      full,
    ),
  ];
}

/**
 * Comment schema: author, body (truncated at the same 500-char baseline as
 * the workitem description unless --full). No `created` column:
 * acli's comment list --json carries only {id, author, body, visibility}
 * (verified live against v1.3.22); author arrives as a plain string.
 */
export function commentSchema(full: boolean): FieldDef[] {
  return [
    custom("author", (item: JsonRecord) => nameOf(item.author) ?? "unknown"),
    truncatedTextField(
      "body",
      (item: JsonRecord) => textOf(item.body).trim(),
      full,
      { fullHint: "use `view <KEY> --full --comments` for complete bodies" },
    ),
  ];
}

/** Render a nested Jira timestamp via the shared relativeTime formatter. */
function relativeOf(item: JsonRecord, name: string): string {
  const raw = fieldOf(item, name);
  const lifted = { [name]: typeof raw === "string" ? raw : null };
  const out = extract(lifted, [relativeTime(name)]);
  return String(out[name] ?? "unknown");
}

/**
 * Normalize acli list-shaped payloads: bare arrays pass through; object
 * envelopes are probed for the usual Jira REST collection keys.
 */
export function itemsOf(payload: unknown, ...keys: string[]): JsonRecord[] {
  if (Array.isArray(payload)) return payload as JsonRecord[];
  if (payload && typeof payload === "object") {
    for (const key of keys) {
      const value = (payload as JsonRecord)[key];
      if (Array.isArray(value)) return value as JsonRecord[];
    }
  }
  return [];
}

/** Probe an acli collection envelope for its server-side total count. */
export function totalOf(payload: unknown): number | undefined {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const total = (payload as JsonRecord).total;
    if (typeof total === "number") return total;
  }
  return undefined;
}

/**
 * Require a numeric ID positional/flag value (boards, sprints, and filters
 * are ID-addressed, unlike key-addressed work items/projects). Rejecting
 * non-digits up front turns a swapped positional into a clear error instead
 * of a confusing acli failure.
 */
export function requireNumericId(
  raw: string | undefined,
  usage: string,
  label = "ID",
): string {
  if (!raw) {
    throw new AxiError(`Missing ${label}`, "VALIDATION_ERROR", [usage]);
  }
  if (!/^\d+$/.test(raw)) {
    throw new AxiError(
      `Invalid ${label}: ${raw} (expected a number)`,
      "VALIDATION_ERROR",
      [usage],
    );
  }
  return raw;
}

/**
 * Render an ISO timestamp as YYYY-MM-DD. Sprint dates are often in the
 * future, where relativeTime's "just now"/"ago" phrasing misleads. The date
 * is taken verbatim from the timestamp's OWN offset (Jira sends timestamps
 * in the site/user zone) - converting through the local machine's timezone
 * or UTC could shift it a day relative to what the Jira UI shows.
 */
export function dateOnly(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})([T ]|$)/);
  if (match) return match[1];
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

/**
 * Reject a silently-ignored SECOND positional. Every jira-axi subcommand takes
 * at most one positional (a key/id, or a quoted query). An unquoted multi-word
 * query - `workitem search project = TEAM` - would otherwise keep only the
 * first token and return wrong results at exit 0. Mirrors confluence-axi's
 * requirePageId guard and the filter-search guard.
 */
export function rejectExtraPositional(args: string[], hint: string): void {
  const extra = args.slice(1).filter((a) => !a.startsWith("--"))[1];
  if (extra !== undefined) {
    throw new AxiError(
      `Unexpected extra argument: ${extra}`,
      "VALIDATION_ERROR",
      [hint],
    );
  }
}

/**
 * Build a dynamic schema from a user-supplied --fields list. `key` is always
 * included; values resolve tolerantly and named objects collapse to names.
 */
export function fieldsSchema(fields: string[]): FieldDef[] {
  const names = ["key", ...fields.filter((f) => f !== "key")];
  return names.map((name) =>
    name === "key"
      ? custom("key", (item: JsonRecord) => item.key ?? null)
      : custom(name, (item: JsonRecord) => {
          const value = fieldOf(item, name);
          if (name === "updated" || name === "created") {
            return relativeOf(item, name);
          }
          // Match the detail view's status render (lowercased real name, not
          // the shortStatus enum): a --fields render is an explicit per-field
          // request, so give the JQL-usable value — "in progress", not "wip"
          // (review finding 2026-07-19; the original sweep bug was the raw
          // "Done" casing, which lowercasing already fixes).
          if (name === "status") {
            return nameOf(fieldOf(item, "status"))?.toLowerCase() ?? "unknown";
          }
          // Parent collapses to the epic/parent key; an absent parent is a real
          // "top-level" state, rendered "none" (not null) so it reads the same
          // as the detail view and never looks like an unreturned field.
          if (name === "parent") {
            return nameOf(fieldOf(item, "parent")) ?? "none";
          }
          // Links collapse to the same count + inline summary as the detail
          // view. The raw `issuelinks` value is an array of full REST issue
          // objects (hundreds of tokens per link), never worth rendering.
          if (name === LINKS_FIELD || name === LINKS_ALIAS) {
            return linksSummaryOf(item);
          }
          if (value && typeof value === "object" && !Array.isArray(value)) {
            const collapsed = nameOf(value);
            return collapsed === null ? null : stripControlChars(collapsed);
          }
          // Arbitrary remote text via the --fields escape hatch: strip C1/DEL
          // controls just like the default schemas do (review finding F6).
          if (typeof value === "string") return stripControlChars(value);
          return value ?? null;
        }),
  );
}

// ---------------------------------------------------------------------------
// Work-item keys
// ---------------------------------------------------------------------------

/** Work-item key shape (PROJECT-NUMBER, e.g. TEAM-1). */
export const WORKITEM_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

/**
 * Require the positional work item key of `workitem <sub> <KEY>`.
 *
 * Jira work item keys are PROJECT-NUMBER (e.g. TEAM-1). Anything else is
 * rejected up front: a value like `-foo` would otherwise reach acli as a
 * POSITIONAL and be parsed as a flag (argv, so not shell injection, but a
 * confusing acli error and a small argument-injection surface), and a non-key
 * like `foo` would only fail after a needless network round-trip.
 */
export function requireWorkitemKey(
  args: string[],
  positional: string | undefined,
  sub: string,
  extraPositionalHint?: string,
): string {
  if (!positional) {
    throw new AxiError(`Missing work item key`, "VALIDATION_ERROR", [
      `Run \`jira-axi workitem ${sub} <KEY> ...\``,
    ]);
  }
  const key = positional.toUpperCase();
  if (!WORKITEM_KEY.test(key)) {
    throw new AxiError(
      `Invalid work item key: ${JSON.stringify(positional)} (expected PROJECT-NUMBER, e.g. TEAM-1)`,
      "VALIDATION_ERROR",
      [`Run \`jira-axi workitem ${sub} <KEY>\``],
    );
  }
  rejectExtraPositional(
    args,
    extraPositionalHint ??
      `This command takes a single <KEY>: jira-axi workitem ${sub} <KEY>`,
  );
  return key;
}

/**
 * Validate a work-item key passed as a FLAG value (`--to`, `--from`). Tests
 * PRESENCE, not truthiness: `--to ""` (e.g. `--to "$KEY"` with the variable
 * unset) must be a loud error, never a silently different command.
 */
export function workitemKeyFlag(
  flag: string,
  raw: string | undefined,
  usage: string,
): string | undefined {
  if (raw === undefined) return undefined;
  const key = raw.toUpperCase();
  if (!WORKITEM_KEY.test(key)) {
    throw new AxiError(
      `Invalid ${flag}: ${JSON.stringify(raw)} (expected a work-item key, e.g. TEAM-1)`,
      "VALIDATION_ERROR",
      [usage],
    );
  }
  return key;
}

/** Quote a JQL string value; backslashes first, then quotes, per JQL escaping. */
export function quoteJql(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// Work-item links
// ---------------------------------------------------------------------------

/** The Jira field carrying a work item's links, as acli's view names it. */
export const LINKS_FIELD = "issuelinks";
/** Friendlier `--fields` spelling, matching the `links` row of the detail view. */
export const LINKS_ALIAS = "links";

/**
 * One link, normalized from THIS work item's point of view.
 *
 * Jira's REST naming is a well-known trap, so it is resolved exactly once,
 * here. A link type has two phrases (Blocks: outward "blocks", inward "is
 * blocked by"). In a work item's `issuelinks` field each entry carries the
 * OTHER end under one of two keys, and that key says which phrase applies:
 *
 *   { outwardIssue: B }  =>  "<this> <outward phrase> B"   (this blocks B)
 *   { inwardIssue:  B }  =>  "<this> <inward phrase> B"    (this is blocked by B)
 *
 * Verified live (acli v1.3.30, 2026-10-01): the entry keys come back verbatim
 * from the REST v3 issue shape, including `type.{name,inward,outward}` and the
 * other item's `fields.{summary,status,issuetype,priority}`.
 */
export interface WorkitemLink {
  /** Link id - what `unlink --id` (acli `link delete --id`) addresses. */
  id: string;
  /** Link type name, e.g. "Blocks". */
  type: string;
  /** The type's outward phrase, e.g. "blocks". */
  outward: string;
  /** The type's inward phrase, e.g. "is blocked by". */
  inward: string;
  /** Which of the two phrases applies from this item's point of view. */
  direction: "outward" | "inward";
  /** The phrase from this item's point of view: "<this> <relation> <key>". */
  relation: string;
  /** The other work item's key. */
  key: string;
  /** The other work item as returned (REST issue shape: key + fields). */
  other: JsonRecord;
}

function cleanText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? stripControlChars(value).trim()
    : undefined;
}

/**
 * Read a work item's links from its `issuelinks` field. Returns `undefined`
 * when the field was not returned at all (never requested, or dropped by
 * acli), which is NOT the same as an empty list - callers must not report
 * "no links" for a field they did not get. Entries missing an id or the other
 * item's key are skipped (shape drift degrades to fewer rows, not a crash).
 */
export function linksOf(item: JsonRecord): WorkitemLink[] | undefined {
  const raw = fieldOf(item, LINKS_FIELD);
  if (!Array.isArray(raw)) return undefined;
  const links: WorkitemLink[] = [];
  for (const entry of raw as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as JsonRecord;
    const direction = record.outwardIssue ? "outward" : "inward";
    const other = record.outwardIssue ?? record.inwardIssue;
    const key = cleanText(other?.key);
    const id = cleanText(typeof record.id === "number" ? String(record.id) : record.id);
    if (!other || typeof other !== "object" || !key || !id) continue;
    const linkType = (record.type ?? {}) as JsonRecord;
    const type = cleanText(linkType.name) ?? "unknown";
    // A missing phrase falls back to the type name so a row still reads.
    const outward = cleanText(linkType.outward) ?? type;
    const inward = cleanText(linkType.inward) ?? type;
    links.push({
      id,
      type,
      outward,
      inward,
      direction,
      relation: direction === "outward" ? outward : inward,
      key,
      other: other as JsonRecord,
    });
  }
  return links;
}

/** How many links the detail view names inline before collapsing to "+N more". */
const LINKS_INLINE_MAX = 5;

/**
 * The detail view's `links` value: a bare `0`, or the count plus a capped
 * inline summary read from this item's point of view, e.g.
 * `2 (blocks TEAM-2; relates to OPS-3)`. `unknown` when acli did not return
 * the field, so an unreturned field never reads as "no links".
 */
export function linksSummaryOf(item: JsonRecord): string | number {
  const links = linksOf(item);
  if (links === undefined) return "unknown";
  if (links.length === 0) return 0;
  const shown = links
    .slice(0, LINKS_INLINE_MAX)
    .map((link) => `${link.relation} ${link.key}`);
  const hidden = links.length - shown.length;
  if (hidden > 0) shown.push(`+${hidden} more`);
  // "; " rather than ", ": a comma would make TOON quote the whole value.
  return `${links.length} (${shown.join("; ")})`;
}

/** Numeric ids render as bare numbers (TOON would quote a digit string). */
export function linkIdValue(id: string): string | number {
  return /^\d{1,15}$/.test(id) ? Number(id) : id;
}

/**
 * Link list schema. Each row reads "<this item> <relation> <key>": the
 * relation is the type's own phrase from the listed item's point of view, so
 * direction never has to be inferred from an inward/outward column. `id` is
 * what `unlink --id` takes.
 */
export const linkListSchema: FieldDef[] = [
  custom("relation", (link: WorkitemLink) => link.relation),
  custom("key", (link: WorkitemLink) => link.key),
  custom("type", (link: WorkitemLink) => link.type),
  custom("status", (link: WorkitemLink) => shortStatus(link.other)),
  custom("summary", (link: WorkitemLink) => summaryOf(link.other)),
  custom("id", (link: WorkitemLink) => linkIdValue(link.id)),
];

/** A link as a sentence from `subject`'s side: "TEAM-1 blocks TEAM-2". */
export function linkSentence(subject: string, link: WorkitemLink): string {
  return `${subject} ${link.relation} ${link.key}`;
}

/** The same link read from the other item's side: "TEAM-2 is blocked by TEAM-1". */
export function linkInverseSentence(
  subject: string,
  link: WorkitemLink,
): string {
  const phrase = link.direction === "outward" ? link.inward : link.outward;
  return `${link.key} ${phrase} ${subject}`;
}
