import type { AcliCall } from "./acliFake.js";
import { makeAcliFake } from "./acliFake.js";

/**
 * A stateful fake Jira site for the mention tests: one ticket (TEAM-1) plus a
 * small user directory reachable only the way acli reaches it - through the
 * ticket's own fields and through assignee/reporter ticket searches.
 *
 * Shapes follow what acli v1.3.30 returned live on 2026-10-07 (read-only
 * probes plus the one approved self-mention write):
 *  - `workitem view --fields ...,comment --json` embeds
 *    `fields.comment.{comments,total}`; each comment is
 *    `{id, author:{accountId,displayName}, body:<stored ADF>}`.
 *  - `workitem list-watchers --json` returns `{watchers:[user...]}`.
 *  - `workitem search --jql '<field> = "<name|email>"'` matches the exact full
 *    name (any case) or the email, never part of a name, and returns `[]` (no
 *    error) for an unknown person. `<field> not in ("<id>")` excludes accounts.
 *  - A user's `emailAddress` is absent when their privacy setting hides it,
 *    though a search by that email still matches.
 *  - `comment create --body-file` stores a mention node as written, adding
 *    `accessLevel: ""`; its JSON output carries no comment id.
 */
export interface SiteUser {
  accountId: string;
  displayName: string;
  /** The real email; searchable even when hidden. */
  email?: string;
  /** Hidden by the user's privacy setting: never returned in a payload. */
  hideEmail?: boolean;
  /** How many tickets this user is the assignee of (search rows). */
  assigned?: number;
  /** How many tickets this user is the reporter of (search rows). */
  reported?: number;
}

export interface MentionSiteOptions {
  users: SiteUser[];
  assignee?: string;
  reporter?: string;
  watchers?: string[];
  comments?: { author: string; body: unknown }[];
  description?: unknown;
  /** Simulate a backend that drops mention nodes on write. */
  stripMentionsOnWrite?: boolean;
  /** Simulate a comment field that does not return the new comment. */
  hideNewComment?: boolean;
}

export const para = (...content: unknown[]) => ({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content }],
});
export const text = (value: string) => ({ type: "text", text: value });
export const mention = (id: string, label?: string) => ({
  type: "mention",
  attrs: { id, ...(label ? { text: label } : {}), accessLevel: "" },
});

function stripMentions(node: unknown): unknown {
  if (!node || typeof node !== "object") return node;
  const record = node as Record<string, unknown>;
  if (record.type === "mention") {
    const attrs = record.attrs as Record<string, unknown>;
    return { type: "text", text: String(attrs.text ?? "") };
  }
  return Array.isArray(record.content)
    ? { ...record, content: record.content.map(stripMentions) }
    : record;
}

function storeMentions(node: unknown): unknown {
  if (!node || typeof node !== "object") return node;
  const record = node as Record<string, unknown>;
  if (record.type === "mention") {
    return {
      ...record,
      attrs: { ...(record.attrs as object), accessLevel: "" },
    };
  }
  return Array.isArray(record.content)
    ? { ...record, content: record.content.map(storeMentions) }
    : record;
}

export function makeMentionSite(options: MentionSiteOptions) {
  const byId = new Map(options.users.map((user) => [user.accountId, user]));
  const payloadUser = (id: string | undefined) => {
    const user = id ? byId.get(id) : undefined;
    if (!user) return null;
    return {
      accountId: user.accountId,
      accountType: "atlassian",
      active: true,
      displayName: user.displayName,
      ...(user.email && !user.hideEmail ? { emailAddress: user.email } : {}),
    };
  };

  let nextId = 5000;
  const comments = (options.comments ?? []).map((comment) => ({
    id: String(nextId++),
    author: payloadUser(comment.author),
    body: comment.body,
  }));
  let hidden = 0;

  const view = (args: string[]) => {
    const requested = (args[args.indexOf("--fields") + 1] ?? "").split(",");
    const all: Record<string, unknown> = {
      summary: "Fix login redirect loop",
      status: { name: "In Progress" },
      issuetype: { name: "Bug" },
      issuelinks: [],
      assignee: payloadUser(options.assignee),
      reporter: payloadUser(options.reporter),
      description: options.description ?? null,
      comment: {
        comments: comments.slice(0, comments.length - hidden),
        total: comments.length,
        startAt: 0,
        maxResults: comments.length,
      },
    };
    const fields: Record<string, unknown> = {};
    for (const name of requested) {
      if (name in all) fields[name] = all[name];
    }
    return { key: "TEAM-1", fields };
  };

  const search = (args: string[]) => {
    const jql = args[args.indexOf("--jql") + 1];
    const limit = Number(args[args.indexOf("--limit") + 1]);
    const parsed =
      /^(assignee|reporter) = "(.*?)"(?: AND \1 not in \((.*?)\))? ORDER BY updated DESC$/.exec(
        jql,
      );
    if (!parsed) throw new Error(`mentionSite: unexpected JQL: ${jql}`);
    const [, field, query, excluded] = parsed;
    const skip = (excluded ?? "")
      .split(",")
      .map((id) => id.trim().replace(/^"|"$/g, ""));
    const wanted = query.toLowerCase();
    const rows: unknown[] = [];
    for (const user of options.users) {
      const matches =
        user.displayName.toLowerCase() === wanted ||
        user.email?.toLowerCase() === wanted;
      if (!matches || skip.includes(user.accountId)) continue;
      const tickets = field === "assignee" ? user.assigned : user.reported;
      for (let n = 0; n < (tickets ?? 0); n++) {
        rows.push({
          key: `OPS-${rows.length + 1}`,
          fields: { [field]: payloadUser(user.accountId) },
        });
      }
    }
    return rows.slice(0, limit);
  };

  let author = options.assignee;
  const fake = makeAcliFake([
    { match: (args) => args[2] === "view", result: null },
    { match: (args) => args[2] === "list-watchers", result: null },
    { match: (args) => args[2] === "search", result: null },
    { match: (args) => args[2] === "comment", result: null },
  ]);
  const runner: typeof fake.runner = async (args, stdin) => {
    await fake.runner(args, stdin); // records the call (and the body file)
    const call = fake.calls[fake.calls.length - 1];
    let result: unknown;
    if (args[2] === "view") {
      result = view(args);
    } else if (args[2] === "list-watchers") {
      result = { watchers: (options.watchers ?? []).map(payloadUser) };
    } else if (args[2] === "search") {
      result = search(args);
    } else if (args[2] === "comment" && args[3] === "create") {
      const doc = options.stripMentionsOnWrite
        ? stripMentions(call.bodyFile)
        : storeMentions(call.bodyFile);
      comments.push({
        id: String(nextId++),
        author: payloadUser(author),
        body: doc,
      });
      if (options.hideNewComment) hidden = 1;
      result = { results: [{ status: "SUCCESS", id: "TEAM-1" }] };
    } else {
      throw new Error(`mentionSite: unexpected acli call: ${args.join(" ")}`);
    }
    return { stdout: JSON.stringify(result), stderr: "", exitCode: 0 };
  };

  return {
    runner,
    calls: fake.calls,
    comments,
    setAuthor: (id: string) => {
      author = id;
    },
    /** The acli write calls made so far (must be empty when nothing was posted). */
    writes: (): AcliCall[] =>
      fake.calls.filter(
        (call) => call.args[2] === "comment" && call.args[3] === "create",
      ),
    searches: (): AcliCall[] =>
      fake.calls.filter((call) => call.args[2] === "search"),
  };
}
