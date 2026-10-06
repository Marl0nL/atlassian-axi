import { AxiError } from "@atlassian-axi/core";
import { mentionToken, type AdfDoc, type AdfNode } from "../../adf.js";
import {
  fieldOf,
  itemsOf,
  stripControlChars,
  type JsonRecord,
} from "./shared.js";

/**
 * Real @-mentions for `workitem comment`.
 *
 * A mention notifies a person and cannot be taken back, so every step here is
 * built to never guess: the body opts in with an explicit `@[...]` token (the
 * converter in adf.ts emits an UNRESOLVED mention node for it), each token must
 * resolve to exactly one Atlassian account, and anything else is a validation
 * error that posts nothing. There is no fallback to plain text.
 *
 * acli has no user search (verified against v1.3.30), so a name or email is
 * resolved from what acli CAN read: the people already on the ticket, then a
 * read-only ticket search on assignee/reporter. That search cannot tell "no
 * such person" from "nobody with a ticket this login can see" - the not-found
 * error says so and points at the account-id form.
 *
 * Verified live (acli v1.3.30, 2026-10-07): a `{type:"mention",attrs:{id,text}}`
 * node in the `--body-file` document is stored by Jira as a mention node (it
 * comes back with an added `accessLevel`). NOT verified: that the notification
 * email is sent, and how Jira treats an account id that does not exist.
 */

/** Most distinct `@[...]` mentions one comment may carry. */
export const MAX_MENTIONS = 5;

/** Rows fetched per people search; a full page triggers the namesake check. */
const PEOPLE_SEARCH_LIMIT = 50;

/** Atlassian account ids are opaque; this only keeps junk out of the document. */
const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;

export interface Person {
  accountId: string;
  name?: string;
  email?: string;
  /** How this person is known, e.g. "assignee", "watcher", "ticket search". */
  where: string[];
}

export interface StoredMention {
  accountId: string;
  name?: string;
}

type TokenKind = "account" | "email" | "name";

export interface MentionRequest {
  /** The token as it should be written back: `@[...]`. */
  label: string;
  kind: TokenKind;
  value: string;
  nodes: AdfNode[];
}

export interface ResolvedMention {
  label: string;
  person: Person;
  nodes: AdfNode[];
}

/** Search ticket assignees/reporters: `field = "<query>"`, minus `exclude`. */
export type PeopleSearch = (
  field: "assignee" | "reporter",
  query: string,
  exclude: string[],
  limit: number,
) => Promise<JsonRecord[]>;

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? stripControlChars(value).trim()
    : undefined;
}

/** Case- and spacing-insensitive form used to compare names and emails. */
function fold(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function walk(node: unknown, visit: (node: JsonRecord) => void): void {
  if (!node || typeof node !== "object") return;
  const record = node as JsonRecord;
  visit(record);
  if (Array.isArray(record.content)) {
    for (const child of record.content) walk(child, visit);
  }
}

/** Every mention node of a document, resolved or not, in reading order. */
export function mentionNodes(doc: AdfDoc): AdfNode[] {
  const nodes: AdfNode[] = [];
  walk(doc, (node) => {
    if (node.type === "mention") nodes.push(node as AdfNode);
  });
  return nodes;
}

/** The distinct accounts a STORED ADF value (comment body, description) mentions. */
export function storedMentions(adf: unknown): StoredMention[] {
  const seen = new Map<string, StoredMention>();
  walk(adf, (node) => {
    if (node.type !== "mention") return;
    const accountId = clean(node.attrs?.id);
    if (!accountId || seen.has(accountId)) return;
    const name = clean(node.attrs?.text)?.replace(/^@/, "");
    seen.set(accountId, { accountId, ...(name ? { name } : {}) });
  });
  return [...seen.values()];
}

function addPerson(
  people: Map<string, Person>,
  raw: unknown,
  where: string,
): void {
  if (!raw || typeof raw !== "object") return;
  const record = raw as JsonRecord;
  const accountId = clean(record.accountId);
  if (!accountId) return;
  const person = people.get(accountId) ?? { accountId, where: [] };
  person.name ??= clean(record.displayName);
  person.email ??= clean(record.emailAddress);
  if (!person.where.includes(where)) person.where.push(where);
  people.set(accountId, person);
}

/**
 * Everyone already on a ticket, keyed by account id: assignee, reporter,
 * comment authors, people mentioned in the description or a comment, and (when
 * the caller fetched them) watchers. `item` is `workitem view --json` output
 * carrying whichever of assignee/reporter/comment/description were requested.
 */
export function peopleOnTicket(
  item: JsonRecord,
  watchers?: unknown,
): Map<string, Person> {
  const people = new Map<string, Person>();
  addPerson(people, fieldOf(item, "assignee"), "assignee");
  addPerson(people, fieldOf(item, "reporter"), "reporter");
  for (const watcher of itemsOf(watchers, "watchers")) {
    addPerson(people, watcher, "watcher");
  }
  const comments = commentsOf(item);
  for (const comment of comments) {
    addPerson(people, comment.author, "commenter");
  }
  for (const adf of [
    fieldOf(item, "description"),
    ...comments.map((comment) => comment.body),
  ]) {
    for (const mention of storedMentions(adf)) {
      addPerson(
        people,
        { accountId: mention.accountId, displayName: mention.name },
        "mentioned before",
      );
    }
  }
  return people;
}

/** The comments embedded in a `workitem view --fields ...,comment` payload. */
export function commentsOf(item: JsonRecord): JsonRecord[] {
  return itemsOf(fieldOf(item, "comment"), "comments");
}

/** "Sam Lee (accountId 123, assignee)" - never an email (privacy settings vary). */
export function describePerson(person: Person): string {
  const name = person.name ?? "name unknown";
  const where = person.where.length > 0 ? `, ${person.where.join("/")}` : "";
  return `${name} (accountId ${person.accountId}${where})`;
}

function classify(node: AdfNode): { label: string; kind: TokenKind; value: string } {
  const token = mentionToken(node);
  if (token === undefined) {
    // A mention node from a raw ADF body: the account id is taken as given.
    const id = clean(node.attrs?.id) ?? "";
    return { label: `@[accountId:${id}]`, kind: "account", value: id };
  }
  const account = /^accountid:\s*(.*)$/i.exec(token);
  if (account) {
    return { label: `@[${token}]`, kind: "account", value: account[1].trim() };
  }
  const kind = /^[^\s@]+@[^\s@]+$/.test(token) ? "email" : "name";
  return { label: `@[${token}]`, kind, value: token };
}

/** Group a document's mention nodes into distinct requests, in reading order. */
export function mentionRequests(doc: AdfDoc): MentionRequest[] {
  const requests = new Map<string, MentionRequest>();
  for (const node of mentionNodes(doc)) {
    const { label, kind, value } = classify(node);
    const id = `${kind}:${fold(value)}`;
    const request = requests.get(id) ?? { label, kind, value, nodes: [] };
    request.nodes.push(node);
    requests.set(id, request);
  }
  return [...requests.values()];
}

function matchesOnTicket(
  request: MentionRequest,
  people: Map<string, Person>,
): Person[] {
  const wanted = fold(request.value);
  return [...people.values()].filter((person) => {
    const have = request.kind === "email" ? person.email : person.name;
    return have !== undefined && fold(have) === wanted;
  });
}

/**
 * Ticket-search candidates for a name or email: everyone the assignee/reporter
 * searches return. A full page may be hiding a namesake behind one busy
 * account, so it is re-queried with the accounts already seen excluded.
 */
async function searchCandidates(
  request: MentionRequest,
  search: PeopleSearch,
): Promise<Person[]> {
  const found = new Map<string, Person>();
  for (const field of ["assignee", "reporter"] as const) {
    const seen: string[] = [];
    for (let round = 0; round <= MAX_MENTIONS; round++) {
      const rows = await search(field, request.value, seen, PEOPLE_SEARCH_LIMIT);
      let added = 0;
      for (const row of rows) {
        const who = fieldOf(row, field);
        const accountId = clean((who as JsonRecord | null)?.accountId);
        if (!accountId || seen.includes(accountId)) continue;
        addPerson(found, who, "ticket search");
        seen.push(accountId);
        added++;
      }
      if (rows.length < PEOPLE_SEARCH_LIMIT || added === 0) break;
    }
  }
  return [...found.values()];
}

function isExact(request: MentionRequest, person: Person): boolean {
  const wanted = fold(request.value);
  if (request.kind === "name") {
    return person.name !== undefined && fold(person.name) === wanted;
  }
  // An email hidden by the person's privacy setting cannot be compared; the
  // search matched on it server-side, so only a VISIBLE different email is a
  // mismatch.
  return person.email === undefined || fold(person.email) === wanted;
}

interface Failure {
  message: string;
  retries: { label: string; person: Person }[];
  hint?: string;
}

/**
 * Resolve every mention request to exactly one account, or throw a
 * VALIDATION_ERROR naming each token that did not (nothing is posted). Order:
 * an account id as given; people on the ticket; a read-only ticket search.
 * `retry` renders the instruction ("Run `...`") for a body with one token replaced.
 */
export async function resolveMentions(
  key: string,
  requests: MentionRequest[],
  people: Map<string, Person>,
  search: PeopleSearch,
  retry: (replace?: { from: string; to: string }) => string,
): Promise<ResolvedMention[]> {
  const resolved: ResolvedMention[] = [];
  const failures: Failure[] = [];

  for (const request of requests) {
    if (request.kind === "account") {
      if (!ACCOUNT_ID.test(request.value)) {
        failures.push({
          message: `${request.label} is not a usable account id`,
          retries: [],
          hint: "An account id looks like @[accountId:5b10ac8d82e05b22cc7d4ef5] - copy it from a candidate list or the person's Jira profile URL",
        });
        continue;
      }
      resolved.push({
        label: request.label,
        nodes: request.nodes,
        person: people.get(request.value) ?? {
          accountId: request.value,
          where: ["account id as given"],
        },
      });
      continue;
    }

    let matches = matchesOnTicket(request, people);
    let near: Person[] = [];
    if (matches.length === 0) {
      const candidates = await searchCandidates(request, search);
      // Prefer what the ticket already knows about an account (its role there).
      const known = candidates.map((person) => {
        const onTicket = people.get(person.accountId);
        return onTicket
          ? { ...person, name: person.name ?? onTicket.name, where: onTicket.where }
          : person;
      });
      matches = known.filter((person) => isExact(request, person));
      near = known.filter((person) => !isExact(request, person));
    }

    if (matches.length === 1) {
      resolved.push({ label: request.label, nodes: request.nodes, person: matches[0] });
    } else if (matches.length > 1) {
      failures.push({
        message: `${request.label} matches ${matches.length} people: ${matches.map(describePerson).join("; ")}`,
        retries: matches.map((person) => ({ label: request.label, person })),
      });
    } else {
      failures.push({
        message:
          `${request.label} matches nobody: no one on ${key}, and no assignee or reporter of a ticket this login can see, has exactly that ${request.kind === "email" ? "email" : "full name"}` +
          (near.length > 0
            ? ` (closest: ${near.map(describePerson).join("; ")})`
            : ""),
        retries: near.map((person) => ({ label: request.label, person })),
        hint:
          request.kind === "email"
            ? `A ticket search cannot tell an unknown person from one with no visible tickets or a hidden email - use their full name @[First Last] or @[accountId:<id>] in place of ${request.label}`
            : `A ticket search cannot tell an unknown person from one with no visible tickets, and it never matches part of a name - use their email @[name@example.com] or @[accountId:<id>] in place of ${request.label}`,
      });
    }
  }

  if (failures.length > 0) {
    throw new AxiError(
      `Mention not resolved, nothing was posted to ${key}: ${failures.map((f) => f.message).join(" | ")}`,
      "VALIDATION_ERROR",
      failures.flatMap((failure) => [
        ...failure.retries.map(
          ({ label, person }) =>
            `${retry({ from: label, to: `@[accountId:${person.accountId}]` })} to mention ${describePerson(person)}`,
        ),
        ...(failure.hint ? [failure.hint] : []),
      ]),
    );
  }

  // Two tokens can name the same account (an email and a name): one mention each
  // in the body, one person notified.
  for (const { nodes, person } of resolved) {
    for (const node of nodes) {
      node.attrs = {
        id: person.accountId,
        ...(person.name ? { text: `@${person.name}` } : {}),
      };
    }
  }
  return resolved;
}

/** The distinct people a resolved set notifies. */
export function distinctPeople(resolved: ResolvedMention[]): Person[] {
  const people = new Map<string, Person>();
  for (const { person } of resolved) {
    if (!people.has(person.accountId)) people.set(person.accountId, person);
  }
  return [...people.values()];
}

/**
 * Prose of a document as the writer typed it, one string per block, skipping
 * code (blocks and inline spans) and mention nodes - the places a bare `@Name`
 * is either deliberate literal text or already a real mention.
 */
function proseBlocks(doc: AdfDoc): string[] {
  const blocks: string[] = [];
  const visit = (node: JsonRecord, into: string[] | null): void => {
    if (node.type === "codeBlock") return;
    if (node.type === "text" && typeof node.text === "string") {
      const isCode =
        Array.isArray(node.marks) &&
        node.marks.some((mark: JsonRecord) => mark?.type === "code");
      into?.push(isCode ? " " : node.text);
      return;
    }
    if (node.type === "mention" || node.type === "hardBreak") {
      into?.push(" ");
      return;
    }
    if (!Array.isArray(node.content)) return;
    const isBlock = node.type === "paragraph" || node.type === "heading";
    const parts: string[] | null = isBlock ? [] : into;
    for (const child of node.content) {
      if (child && typeof child === "object") visit(child as JsonRecord, parts);
    }
    if (isBlock && parts) blocks.push(parts.join(""));
  };
  visit(doc as unknown as JsonRecord, null);
  return blocks;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The note for a body that wrote `@Name` WITHOUT brackets for someone on the
 * ticket: it was stored as plain text and notified nobody. Matches the full
 * display name, or a first name only one person on the ticket has. Returns
 * undefined when there is nothing to say.
 */
export function bareMentionNote(
  doc: AdfDoc,
  people: Map<string, Person>,
): string | undefined {
  const prose = proseBlocks(doc);
  if (!prose.some((block) => block.includes("@"))) return undefined;

  const named = [...people.values()].filter((person) => person.name);
  const firstNames = new Map<string, Person[]>();
  for (const person of named) {
    const first = fold(person.name as string).split(" ")[0];
    firstNames.set(first, [...(firstNames.get(first) ?? []), person]);
  }
  const written = (text: string) =>
    prose.some((block) =>
      new RegExp(`(?<![\\w.@])@${escapeRegExp(text).replace(/ /g, "\\s+")}(?![\\w@])`, "i").test(block),
    );

  const hits = named.filter((person) => {
    const name = fold(person.name as string);
    const first = name.split(" ")[0];
    return (
      written(name) ||
      ((firstNames.get(first) ?? []).length === 1 && written(first))
    );
  });
  if (hits.length === 0) return undefined;
  const fixes = hits
    .map((person) => `@[${person.name}] for ${describePerson(person)}`)
    .join("; ");
  return `note: a bare @Name is stored as plain text and notifies nobody. To mention someone on this ticket write the bracket form and pass --mention: ${fixes}`;
}
