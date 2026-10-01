import { acliExec, acliJson } from "../../acli.js";
import {
  AxiError,
  closestCommand,
  custom,
  firstLine,
  formatCountLine,
  renderDetail,
  renderHelp,
  renderList,
  renderOutput,
  type FieldDef,
  type SiteContext,
} from "@atlassian-axi/core";
import { getSuggestions } from "../../suggestions.js";
import { workitemHelp } from "./workitem-help.js";
import {
  LINKS_FIELD,
  itemsOf,
  linkIdValue,
  linkInverseSentence,
  linkListSchema,
  linkSentence,
  linksOf,
  parseFlags,
  parseLimit,
  quoteJql,
  requireNumericId,
  requireWorkitemKey,
  stripControlChars,
  workitemKeyFlag,
  type JsonRecord,
  type WorkitemLink,
} from "./shared.js";

/**
 * Work-item links: `link`, `unlink`, `list-links`, `link-types`.
 *
 * Built on acli's `workitem link {create,delete,type}` for the mutations and
 * the type names, and on `workitem view --fields issuelinks` for every READ.
 * acli's own `link list` is not used: its JSON carries only
 * `{id, outwardIssueKey, typeName}`, with `outwardIssueKey: null` for every
 * link where the listed item is on the outward side - so half the links come
 * back without the other key (verified live, acli v1.3.30). The `issuelinks`
 * field has both ends, the type's phrases, and the other item's summary and
 * status in one call.
 */

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * `workitem view --json` for one key. acli's not-found text names no key
 * ("Issue does not exist or you do not have permission to see it."), which is
 * useless when a command involves TWO work items - say which one.
 */
async function viewFields(key: string, fields: string): Promise<JsonRecord> {
  let payload: unknown;
  try {
    payload = await acliJson<unknown>([
      "jira",
      "workitem",
      "view",
      key,
      "--fields",
      fields,
      "--json",
    ]);
  } catch (error) {
    if (error instanceof AxiError && error.code === "NOT_FOUND") {
      throw notFound(key);
    }
    throw error;
  }
  const item = Array.isArray(payload) ? payload[0] : payload;
  if (!item || typeof item !== "object") throw notFound(key);
  return item as JsonRecord;
}

function notFound(key: string): AxiError {
  return new AxiError(
    `Work item not found: ${key} (it does not exist, or this login cannot see it)`,
    "NOT_FOUND",
    ['Find the right key with `jira-axi workitem search "<JQL>"`'],
  );
}

/** A work item's links, from its `issuelinks` field. */
async function fetchLinks(key: string): Promise<WorkitemLink[]> {
  const links = linksOf(await viewFields(key, `key,${LINKS_FIELD}`));
  if (links === undefined) {
    // Never guess: an idempotency check or an empty state built on a field
    // acli did not return would claim "no links" without having looked.
    throw new AxiError(
      `acli did not return the links of ${key} (no \`${LINKS_FIELD}\` field in its output)`,
      "UNKNOWN",
      ["Run `acli --version` - link support was verified against acli v1.3.30"],
    );
  }
  return links;
}

// ---------------------------------------------------------------------------
// Link types
// ---------------------------------------------------------------------------

/** Where a type's phrases came from - see {@link loadLinkTypes}. */
type PhraseSource = "live" | "default" | "unknown";

interface LinkType {
  name: string;
  outward?: string;
  inward?: string;
  source: PhraseSource;
}

/**
 * Phrases of the link types every Jira Cloud site ships with. Used ONLY as a
 * fallback for a type that no visible work item uses yet (so there is no link
 * to read the real phrases from): a site admin can rename these, which is why
 * a fallback row is flagged in `link-types` and why `link` re-reads the
 * created link and checks its real phrase. Verified against a live site
 * 2026-10-01 (all six matched).
 */
const DEFAULT_PHRASES: Record<string, { outward: string; inward: string }> = {
  blocks: { outward: "blocks", inward: "is blocked by" },
  cloners: { outward: "clones", inward: "is cloned by" },
  duplicate: { outward: "duplicates", inward: "is duplicated by" },
  "problem/incident": { outward: "causes", inward: "is caused by" },
  relates: { outward: "relates to", inward: "relates to" },
  "polaris work item link": {
    outward: "implements",
    inward: "is implemented by",
  },
  "polaris issue link": { outward: "implements", inward: "is implemented by" },
};

/** Link type names (acli's `link type --json` carries names only). */
async function fetchLinkTypeNames(): Promise<string[]> {
  const payload = await acliJson<unknown>([
    "jira",
    "workitem",
    "link",
    "type",
    "--json",
  ]);
  const names = itemsOf(payload, "issueLinkTypes", "linkTypes", "values")
    .map((entry) =>
      typeof entry === "string" ? entry : (entry as JsonRecord)?.name,
    )
    .filter((name): name is string => typeof name === "string" && name !== "")
    .map((name) => stripControlChars(name));
  return [...new Set(names)];
}

/** Parallel acli calls are bounded so a site with many types cannot fan out. */
const DISCOVERY_CONCURRENCY = 6;

async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/**
 * Read one type's real phrases off an existing link. acli exposes no
 * link-type detail (names only, no REST passthrough), but every link in a
 * work item's `issuelinks` field carries its type's `inward`/`outward`
 * phrases - so find ONE work item using the type (JQL `issueLinkType`) and
 * read them there. Two read-only calls; best-effort (a failure is "no
 * evidence", never an error, because the phrases are advisory).
 */
async function discoverPhrases(
  name: string,
): Promise<{ outward: string; inward: string } | undefined> {
  try {
    // `--fields key,summary`, not `key` alone: acli returns `[null]` for a
    // key-only search (verified live, v1.3.30).
    const found = await acliJson<unknown>([
      "jira",
      "workitem",
      "search",
      "--jql",
      `issueLinkType = ${quoteJql(name)}`,
      "--limit",
      "1",
      "--fields",
      "key,summary",
      "--json",
    ]);
    const key = itemsOf(found, "issues", "workItems", "results", "values")[0]
      ?.key;
    if (typeof key !== "string") return undefined;
    // `issueLinkType` also matches on a phrase, so confirm the type by NAME.
    const link = (await fetchLinks(key)).find((candidate) =>
      sameText(candidate.type, name),
    );
    return link ? { outward: link.outward, inward: link.inward } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The site's link types with their phrases: read live off an existing link
 * where one exists, else Jira's shipped defaults, else unknown.
 */
async function loadLinkTypes(names: readonly string[]): Promise<LinkType[]> {
  return mapBounded(names, DISCOVERY_CONCURRENCY, async (name) => {
    const live = await discoverPhrases(name);
    if (live) return { name, ...live, source: "live" as const };
    const fallback = DEFAULT_PHRASES[name.toLowerCase()];
    if (fallback) return { name, ...fallback, source: "default" as const };
    return { name, source: "unknown" as const };
  });
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** What `--type` resolved to. */
interface ResolvedType {
  /** Canonical type name, as the site spells it. */
  name: string;
  /** Which phrase applies from <KEY>'s side: "<KEY> <phrase> <other>". */
  direction: "outward" | "inward";
  /** Set when `--type` was a phrase: the created link must read exactly so. */
  phrase?: string;
}

/**
 * Resolve a `--type` value against the site's link types. A type NAME is the
 * fast path (one acli call). Anything else is tried as one of the types'
 * phrases, which costs the discovery round-trips of {@link loadLinkTypes}.
 * Unknown values are a VALIDATION_ERROR (exit 2) that lists the valid types,
 * so the correction takes one turn.
 */
async function resolveLinkType(
  raw: string,
  reverse: boolean,
): Promise<ResolvedType> {
  const names = await fetchLinkTypeNames();
  const byName = names.find((name) => sameText(name, raw));
  if (byName) {
    return { name: byName, direction: reverse ? "inward" : "outward" };
  }

  const types = await loadLinkTypes(names);
  const matches: ResolvedType[] = [];
  for (const type of types) {
    if (type.outward && sameText(type.outward, raw)) {
      matches.push({
        name: type.name,
        direction: "outward",
        phrase: type.outward,
      });
    } else if (type.inward && sameText(type.inward, raw)) {
      matches.push({
        name: type.name,
        direction: "inward",
        phrase: type.inward,
      });
    }
  }

  if (matches.length === 1) {
    if (reverse) {
      throw new AxiError(
        `--reverse cannot be combined with a phrase ("${matches[0].phrase}" already states the direction)`,
        "VALIDATION_ERROR",
        [
          `Drop --reverse to link "<KEY> ${matches[0].phrase} <--to KEY>"`,
          `Or pass the type name: --type ${quoteArg(matches[0].name)} --reverse`,
        ],
      );
    }
    return matches[0];
  }
  if (matches.length > 1) {
    throw new AxiError(
      `Ambiguous link type: ${JSON.stringify(raw)} is a phrase of ${matches.map((m) => m.name).join(", ")}`,
      "VALIDATION_ERROR",
      ["Pass the type NAME instead (add --reverse for its inward direction)"],
    );
  }

  const candidates = types.flatMap((type) => [
    type.name,
    ...(type.outward ? [type.outward] : []),
    ...(type.inward ? [type.inward] : []),
  ]);
  const nearest = closestCommand(raw, candidates);
  throw new AxiError(
    `Unknown link type: ${JSON.stringify(raw)}`,
    "VALIDATION_ERROR",
    [
      ...(nearest ? [`Did you mean \`${nearest}\`?`] : []),
      types.length > 0
        ? `Link types (outward | inward phrase): ${types.map(describeType).join(", ")}`
        : "This site returned no link types - run `acli jira auth status` to verify the login and site",
    ],
  );
}

function describeType(type: LinkType): string {
  return type.outward && type.inward
    ? `${type.name} (${type.outward} | ${type.inward})`
    : type.name;
}

/** Quote a value for a suggested command line when it needs it. */
function quoteArg(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Confirmation schema for one link, read from `subject`'s side. */
function linkResultSchema(subject: string, message: string): FieldDef[] {
  return [
    custom("id", (link: WorkitemLink) => linkIdValue(link.id)),
    custom("relation", (link: WorkitemLink) => linkSentence(subject, link)),
    custom("inverse", (link: WorkitemLink) =>
      linkInverseSentence(subject, link),
    ),
    custom("type", (link: WorkitemLink) => link.type),
    custom("message", () => message),
  ];
}

/**
 * The count line + rows of a link list (or the definitive empty state).
 * Shared by `list-links` and `view --links`. Jira returns ALL of an item's
 * links in the one field, so `links.length` is the true total and the slice
 * is client-side (`displayLimit`).
 *
 * The `reads:` line is the legend for the rows - which way round a row reads
 * is the one thing an agent must not guess. It is part of the content (so
 * `view --links` carries it too), not a `help[]` line: those stay runnable
 * commands.
 */
export function renderLinkList(
  key: string,
  links: readonly WorkitemLink[],
  limit: number,
): string[] {
  if (links.length === 0) {
    return [
      formatCountLine({ count: 0 }),
      `links: 0 work item links on ${key}`,
    ];
  }
  return [
    formatCountLine({ count: links.length, displayLimit: limit }),
    `reads: ${key} <relation> <key>`,
    renderList("links", links.slice(0, limit), linkListSchema),
  ];
}

// ---------------------------------------------------------------------------
// list-links
// ---------------------------------------------------------------------------

export async function listWorkitemLinks(
  args: string[],
  ctx?: SiteContext,
): Promise<string> {
  const parsed = parseFlags(args, { values: ["--limit"] });
  if (parsed.help) return workitemHelp("list-links");

  const key = requireWorkitemKey(args, parsed.positional, "list-links");
  const limit = parseLimit(parsed.values["--limit"]);
  const links = await fetchLinks(key);

  return renderOutput([
    ...renderLinkList(key, links, limit),
    renderHelp(
      getSuggestions({
        domain: "workitem",
        action: "list-links",
        id: key,
        isEmpty: links.length === 0,
        site: ctx,
      }),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// link-types
// ---------------------------------------------------------------------------

export async function listLinkTypes(
  args: string[],
  ctx?: SiteContext,
): Promise<string> {
  const parsed = parseFlags(args, {});
  if (parsed.help) return workitemHelp("link-types");
  if (parsed.positional !== undefined) {
    throw new AxiError(
      `Unexpected argument: ${parsed.positional}`,
      "VALIDATION_ERROR",
      ["Run `jira-axi workitem link-types` (it takes no arguments)"],
    );
  }

  const types = await loadLinkTypes(await fetchLinkTypeNames());
  const blocks: string[] = [formatCountLine({ count: types.length })];
  if (types.length === 0) {
    blocks.push("types: 0 link types returned for this site");
  } else {
    blocks.push(
      renderList("types", types, [
        custom("name", (type: LinkType) => type.name),
        custom("outward", (type: LinkType) => type.outward ?? "unknown"),
        custom("inward", (type: LinkType) => type.inward ?? "unknown"),
      ]),
    );
  }

  // Say how much each phrase can be trusted, but only when it is not simply
  // "read off a real link" - the common case stays one line per type.
  const unconfirmed = types.filter((type) => type.source === "default");
  const unknown = types.filter((type) => type.source === "unknown");
  if (unconfirmed.length > 0) {
    blocks.push(
      `note: phrases of ${unconfirmed.map((t) => t.name).join(", ")} are Jira's defaults, unconfirmed on this site (no visible work item uses the type yet); \`link\` prints the real phrase once linked`,
    );
  }
  if (unknown.length > 0) {
    blocks.push(
      `note: phrases of ${unknown.map((t) => t.name).join(", ")} are unknown (custom type, and no visible work item uses it yet); link by NAME and read the phrase \`link\` prints (--reverse swaps the sides)`,
    );
  }

  blocks.push(
    renderHelp(
      getSuggestions({
        domain: "workitem",
        action: "link-types",
        isEmpty: types.length === 0,
        site: ctx,
      }),
    ),
  );
  return renderOutput(blocks);
}

// ---------------------------------------------------------------------------
// link
// ---------------------------------------------------------------------------

const LINK_USAGE =
  "Run `jira-axi workitem link <KEY> --to <KEY> --type <name|phrase>`";

export async function linkWorkitem(
  args: string[],
  ctx?: SiteContext,
): Promise<string> {
  const parsed = parseFlags(args, {
    values: ["--to", "--type"],
    bools: ["--reverse"],
  });
  if (parsed.help) return workitemHelp("link");

  const key = requireWorkitemKey(
    args,
    parsed.positional,
    "link",
    "Pass the other work item with --to: jira-axi workitem link <KEY> --to <KEY> --type <name|phrase>",
  );
  const other = workitemKeyFlag("--to", parsed.values["--to"], LINK_USAGE);
  const rawType = parsed.values["--type"]?.trim();
  const missing = [
    other === undefined ? "--to" : null,
    !rawType ? "--type" : null,
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new AxiError(
      `Missing required flags: ${missing.join(", ")}`,
      "VALIDATION_ERROR",
      [LINK_USAGE, "Run `jira-axi workitem link-types` to see the link types"],
    );
  }
  if (other === key) {
    throw new AxiError(`Cannot link ${key} to itself`, "VALIDATION_ERROR", [
      LINK_USAGE,
    ]);
  }
  const otherKey = other as string;

  // Input validation first (exit 2), then the state reads in parallel: this
  // item's current links (the idempotency check) and proof the other item
  // exists - so a bad key is a clean NOT_FOUND that names it, before any write.
  const wanted = await resolveLinkType(
    rawType as string,
    parsed.bools["--reverse"],
  );
  const [before] = await Promise.all([
    fetchLinks(key),
    viewFields(otherKey, "key,summary"),
  ]);

  const existing = before.find((link) => matchesWanted(link, otherKey, wanted));
  if (existing) {
    return renderLinkResult(key, existing, "Already linked (no-op)", ctx);
  }

  // The direction trap, resolved once. acli's `--out`/`--in` map verbatim onto
  // the REST link's outwardIssue/inwardIssue, and Jira reads a link as
  // "<inwardIssue> <outward phrase> <outwardIssue>" - so the item that DOES
  // the blocking goes in `--in`, despite the flag name. Verified live (acli
  // v1.3.30): `--out A --in B` left A's issuelinks with `inwardIssue: B`.
  // The re-read below is the guard if a future acli ever changes this.
  const [subject, object] =
    wanted.direction === "outward" ? [key, otherKey] : [otherKey, key];
  const stdout = await acliExec([
    "jira",
    "workitem",
    "link",
    "create",
    "--in",
    subject,
    "--out",
    object,
    "--type",
    wanted.name,
    "--yes",
  ]);

  // acli's link create has no --json and may exit 0 without linking, so the
  // authoritative answer is the item's own links, re-read.
  const after = await fetchLinks(key);
  const created = after.find((link) => matchesWanted(link, otherKey, wanted));
  if (!created) {
    const known = new Set(before.map((link) => link.id));
    const stray = after.find(
      (link) => !known.has(link.id) && link.key === otherKey,
    );
    if (stray) throw wrongWayRound(key, stray, wanted);
    throw new AxiError(
      `Link was not created: ${key} has no ${wanted.name} link to ${otherKey} after acli returned (${firstLine(stripControlChars(stdout)) || "no output"})`,
      "UNKNOWN",
      [`Run \`jira-axi workitem list-links ${key}\` to see its links`],
    );
  }
  return renderLinkResult(key, created, "Linked", ctx);
}

/** A type whose two phrases are the same ("relates to") has no direction. */
function isSymmetric(link: WorkitemLink): boolean {
  return sameText(link.outward, link.inward);
}

/**
 * Whether `link` is the link to `other` that was asked for. A PHRASE request
 * is matched on the link's REAL phrase (read from Jira), which outranks the
 * direction inferred from the phrase table - so a site that renamed a type's
 * phrases can never have the wrong link reported as the right one.
 */
function matchesWanted(
  link: WorkitemLink,
  other: string,
  wanted: ResolvedType,
): boolean {
  if (link.key !== other || !sameText(link.type, wanted.name)) return false;
  if (wanted.phrase) return sameText(link.relation, wanted.phrase);
  return link.direction === wanted.direction || isSymmetric(link);
}

/**
 * The link exists but does not read the way it was asked for. Only reachable
 * if acli's --in/--out semantics change, or a site renamed a default type's
 * phrases while no work item used the type (so there was nothing to read the
 * real phrases from). Loud, with the exact way back.
 */
function wrongWayRound(
  key: string,
  created: WorkitemLink,
  wanted: ResolvedType,
): AxiError {
  const asked = wanted.phrase ?? `${wanted.name} (${wanted.direction})`;
  return new AxiError(
    `Link ${created.id} was created but reads "${linkSentence(key, created)}", not the requested ${JSON.stringify(asked)}`,
    "UNKNOWN",
    [
      `Run \`jira-axi workitem unlink ${key} --id ${created.id}\` to remove it`,
      `Then run \`jira-axi workitem link ${created.key} --to ${key} --type ${quoteArg(created.type)}\` for the other direction`,
    ],
  );
}

function renderLinkResult(
  key: string,
  link: WorkitemLink,
  message: string,
  ctx?: SiteContext,
): string {
  return renderOutput([
    renderDetail("link", link, linkResultSchema(key, message)),
    renderHelp(
      getSuggestions({
        domain: "workitem",
        action: "link",
        id: key,
        state: link.id,
        site: ctx,
      }),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// unlink
// ---------------------------------------------------------------------------

const UNLINK_USAGE =
  "Run `jira-axi workitem unlink <KEY> --from <KEY> [--type <name|phrase>]` or `jira-axi workitem unlink <KEY> --id <link id>`";

export async function unlinkWorkitem(
  args: string[],
  ctx?: SiteContext,
): Promise<string> {
  const parsed = parseFlags(args, { values: ["--from", "--type", "--id"] });
  if (parsed.help) return workitemHelp("unlink");

  const key = requireWorkitemKey(
    args,
    parsed.positional,
    "unlink",
    "Pass the other work item with --from: jira-axi workitem unlink <KEY> --from <KEY>",
  );
  const other = workitemKeyFlag(
    "--from",
    parsed.values["--from"],
    UNLINK_USAGE,
  );
  const rawId = parsed.values["--id"];
  const rawType = parsed.values["--type"]?.trim();

  if (other === undefined && rawId === undefined) {
    throw new AxiError(
      "Missing --from <KEY> or --id <link id>",
      "VALIDATION_ERROR",
      [
        UNLINK_USAGE,
        `Run \`jira-axi workitem list-links ${key}\` to see its links and their ids`,
      ],
    );
  }
  if (other !== undefined && rawId !== undefined) {
    throw new AxiError(
      "Use either --from or --id, not both",
      "VALIDATION_ERROR",
      [UNLINK_USAGE],
    );
  }
  if (parsed.values["--type"] !== undefined) {
    if (rawId !== undefined) {
      throw new AxiError(
        "--type only applies with --from (an --id already names one link)",
        "VALIDATION_ERROR",
        [UNLINK_USAGE],
      );
    }
    if (!rawType) {
      throw new AxiError("--type requires a value", "VALIDATION_ERROR", [
        UNLINK_USAGE,
      ]);
    }
  }
  if (other === key) {
    throw new AxiError(
      `--from must be a different work item than ${key}`,
      "VALIDATION_ERROR",
      [UNLINK_USAGE],
    );
  }
  const id =
    rawId === undefined
      ? undefined
      : requireNumericId(rawId, UNLINK_USAGE, "--id");

  // Only ever delete a link that is ON <KEY>: the id/--from is matched against
  // this item's own links, so a mistyped id cannot remove a stranger's link.
  const links = await fetchLinks(key);
  const target =
    id !== undefined
      ? links.find((link) => link.id === id)
      : await pickLink(key, links, other as string, rawType);

  if (!target) {
    const what =
      id !== undefined
        ? `link with id ${id}`
        : `${rawType ? `${rawType} ` : ""}link to ${other}`;
    // When --type narrowed the match to nothing, say what DOES still link the
    // two, so "already unlinked" is never read as "these are unrelated".
    const remaining =
      id === undefined ? links.filter((link) => link.key === other) : [];
    return renderOutput([
      renderDetail(
        "link",
        {
          message: `Already unlinked - ${key} has no ${what} (no-op)`,
          remaining: remaining
            .map((link) => `${linkSentence(key, link)} (id ${link.id})`)
            .join("; "),
        },
        [
          custom("message", (item: JsonRecord) => item.message),
          ...(remaining.length > 0
            ? [custom("still_linked", (item: JsonRecord) => item.remaining)]
            : []),
        ],
      ),
      renderHelp(
        getSuggestions({
          domain: "workitem",
          action: "unlink",
          id: key,
          site: ctx,
        }),
      ),
    ]);
  }

  // acli's link delete has no --json either; `--yes` suppresses its prompt.
  const stdout = await acliExec([
    "jira",
    "workitem",
    "link",
    "delete",
    "--id",
    target.id,
    "--yes",
  ]);
  const after = await fetchLinks(key);
  if (after.some((link) => link.id === target.id)) {
    throw new AxiError(
      `Link ${target.id} was not removed: it is still on ${key} after acli returned (${firstLine(stripControlChars(stdout)) || "no output"})`,
      "UNKNOWN",
      [`Run \`jira-axi workitem list-links ${key}\` to see its links`],
    );
  }

  return renderOutput([
    renderDetail("link", target, linkResultSchema(key, "Unlinked")),
    renderHelp(
      getSuggestions({
        domain: "workitem",
        action: "unlink",
        id: key,
        site: ctx,
      }),
    ),
  ]);
}

/**
 * Pick the one link between `key` and `other` that `unlink --from` means.
 * `undefined` = nothing to remove (a no-op). More than one candidate is a
 * VALIDATION_ERROR naming each: guessing which link to DELETE is not safe.
 */
async function pickLink(
  key: string,
  links: readonly WorkitemLink[],
  other: string,
  rawType: string | undefined,
): Promise<WorkitemLink | undefined> {
  const between = links.filter((link) => link.key === other);
  let candidates = between;
  if (rawType) {
    // A type NAME matches either direction; a PHRASE matches only the link
    // that reads "<KEY> <phrase> <other>".
    candidates = between.filter(
      (link) =>
        sameText(link.type, rawType) || sameText(link.relation, rawType),
    );
    if (candidates.length === 0) {
      // Nothing matched: before calling that a no-op, make sure the value is a
      // real type or phrase - a typo must not read as "already unlinked".
      const seen = links.some(
        (link) =>
          sameText(link.type, rawType) ||
          sameText(link.outward, rawType) ||
          sameText(link.inward, rawType),
      );
      if (!seen) await resolveLinkType(rawType, false);
      return undefined;
    }
  }
  if (candidates.length > 1) {
    throw new AxiError(
      `${candidates.length} links between ${key} and ${other} match - ${candidates.map((link) => `${link.relation} (${link.type}, id ${link.id})`).join("; ")}`,
      "VALIDATION_ERROR",
      [
        `Run \`jira-axi workitem unlink ${key} --id <id>\` to remove exactly one`,
        ...(rawType
          ? []
          : [
              `Or narrow it: \`jira-axi workitem unlink ${key} --from ${other} --type <name|phrase>\``,
            ]),
      ],
    );
  }
  return candidates[0];
}
