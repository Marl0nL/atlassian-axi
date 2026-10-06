import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setAcliRunner } from "../../../src/acli.js";
import { workitemCommand } from "../../../src/commands/jira/workitem.js";
import {
  makeMentionSite,
  mention,
  para,
  text,
  type MentionSiteOptions,
  type SiteUser,
} from "../../helpers/mentionSite.js";

afterEach(() => {
  setAcliRunner(null);
});

const JANE: SiteUser = {
  accountId: "acc-jane",
  displayName: "Jane Doe",
  email: "jane@acme.com",
};
const RAVI: SiteUser = {
  accountId: "acc-ravi",
  displayName: "Ravi Patel",
  email: "ravi@acme.com",
  hideEmail: true,
  reported: 2,
};
const SAM_A: SiteUser = { accountId: "acc-sam-a", displayName: "Sam Lee" };
const SAM_B: SiteUser = {
  accountId: "acc-sam-b",
  displayName: "Sam Lee",
  assigned: 1,
};
const OTTO: SiteUser = {
  accountId: "acc-otto",
  displayName: "Otto Berg",
  email: "otto@acme.com",
  assigned: 3,
};
const USERS = [JANE, RAVI, SAM_A, SAM_B, OTTO];

function site(overrides: Partial<MentionSiteOptions> = {}) {
  const s = makeMentionSite({
    users: USERS,
    assignee: JANE.accountId,
    reporter: RAVI.accountId,
    ...overrides,
  });
  setAcliRunner(s.runner);
  return s;
}

const comment = (body: string, ...flags: string[]) =>
  workitemCommand(["comment", "TEAM-1", "--body", body, ...flags]);

async function failure(run: Promise<string>) {
  try {
    await run;
  } catch (error) {
    return error as { message: string; code: string; suggestions: string[] };
  }
  throw new Error("expected the command to fail");
}

/** The mention nodes of the body acli was handed. */
function sentMentions(s: ReturnType<typeof site>) {
  const out: unknown[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as { type?: string; content?: unknown[] };
    if (record.type === "mention") out.push(node);
    record.content?.forEach(walk);
  };
  walk(s.writes()[0]?.bodyFile);
  return out;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe("workitem comment mentions - resolution", () => {
  it("mentions the assignee by email and reports the stored mention", async () => {
    const s = site();
    const out = await comment("@[jane@acme.com] ready for review", "--mention");

    expect(sentMentions(s)).toEqual([
      { type: "mention", attrs: { id: "acc-jane", text: "@Jane Doe" } },
    ]);
    expect(out).toContain(
      "message: Comment added (id 5000); mentions confirmed in the stored comment",
    );
    expect(out).toContain("mentions[1]{name,account}:\n  Jane Doe,acc-jane");
    // Found on the ticket: no ticket search was needed.
    expect(s.searches()).toHaveLength(0);
  });

  it("matches a full name on the ticket ignoring case and spacing", async () => {
    const s = site();
    await comment("ping @[ jane   DOE ]", "--mention");
    expect(sentMentions(s)).toEqual([
      { type: "mention", attrs: { id: "acc-jane", text: "@Jane Doe" } },
    ]);
  });

  it("resolves from watchers, comment authors and earlier mentions", async () => {
    const s = site({
      watchers: [SAM_A.accountId],
      comments: [
        {
          author: OTTO.accountId,
          body: para(text("cc "), mention("acc-zed", "@Zed Quill")),
        },
      ],
    });
    await comment(
      "@[Sam Lee] @[Otto Berg] @[Zed Quill] please look",
      "--mention",
    );
    expect(sentMentions(s)).toEqual([
      { type: "mention", attrs: { id: "acc-sam-a", text: "@Sam Lee" } },
      { type: "mention", attrs: { id: "acc-otto", text: "@Otto Berg" } },
      { type: "mention", attrs: { id: "acc-zed", text: "@Zed Quill" } },
    ]);
    expect(s.searches()).toHaveLength(0);
  });

  it("uses an account id as given, with no lookup at all", async () => {
    const s = site();
    const out = await comment("@[accountId:acc-nobody-known] fyi", "--mention");
    expect(sentMentions(s)).toEqual([
      { type: "mention", attrs: { id: "acc-nobody-known" } },
    ]);
    expect(s.searches()).toHaveLength(0);
    expect(s.calls.some((c) => c.args[2] === "list-watchers")).toBe(false);
    expect(out).toContain("mentions[1]{name,account}:\n  unknown,acc-nobody-known");
  });

  it("names an account id when that account is on the ticket", async () => {
    const s = site();
    await comment("@[accountId:acc-jane] fyi", "--mention");
    expect(sentMentions(s)).toEqual([
      { type: "mention", attrs: { id: "acc-jane", text: "@Jane Doe" } },
    ]);
  });

  it("falls back to a read-only ticket search for someone not on the ticket", async () => {
    const s = site();
    await comment("@[otto berg] can you check", "--mention");
    expect(sentMentions(s)).toEqual([
      { type: "mention", attrs: { id: "acc-otto", text: "@Otto Berg" } },
    ]);
    expect(s.searches().map((c) => c.args[c.args.indexOf("--jql") + 1])).toEqual([
      'assignee = "otto berg" ORDER BY updated DESC',
      'reporter = "otto berg" ORDER BY updated DESC',
    ]);
  });

  it("finds a hidden email through the search when the ticket cannot show it", async () => {
    // Ravi is the reporter, but his email is hidden, so the ticket lookup
    // misses and the search (which matches server-side) finds him.
    const s = site();
    await comment("@[ravi@acme.com] over to you", "--mention");
    expect(sentMentions(s)).toEqual([
      { type: "mention", attrs: { id: "acc-ravi", text: "@Ravi Patel" } },
    ]);
    expect(s.searches().length).toBeGreaterThan(0);
  });

  it("fails on two people with the same name on the ticket, listing both and the retry", async () => {
    const s = site({ watchers: [SAM_A.accountId, SAM_B.accountId] });
    const err = await failure(comment("@[Sam Lee] please look", "--mention"));

    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toBe(
      "Mention not resolved, nothing was posted to TEAM-1: @[Sam Lee] matches 2 people: Sam Lee (accountId acc-sam-a, watcher); Sam Lee (accountId acc-sam-b, watcher)",
    );
    expect(err.suggestions).toEqual([
      "Run `jira-axi workitem comment TEAM-1 --body '@[accountId:acc-sam-a] please look' --mention` to mention Sam Lee (accountId acc-sam-a, watcher)",
      "Run `jira-axi workitem comment TEAM-1 --body '@[accountId:acc-sam-b] please look' --mention` to mention Sam Lee (accountId acc-sam-b, watcher)",
    ]);
    expect(s.writes()).toHaveLength(0);
  });

  it("fails on two search matches, even when one hides behind a full page", async () => {
    const busy: SiteUser = {
      accountId: "acc-kim-busy",
      displayName: "Kim Roe",
      assigned: 80,
    };
    const quiet: SiteUser = {
      accountId: "acc-kim-quiet",
      displayName: "Kim Roe",
      assigned: 1,
    };
    const s = site({ users: [...USERS, busy, quiet] });
    const err = await failure(comment("@[Kim Roe] hi", "--mention"));

    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toContain("@[Kim Roe] matches 2 people");
    expect(err.message).toContain("accountId acc-kim-busy, ticket search");
    expect(err.message).toContain("accountId acc-kim-quiet, ticket search");
    // The first page was all one account; the namesake check re-queried
    // with that account excluded.
    expect(
      s.searches().map((c) => c.args[c.args.indexOf("--jql") + 1]),
    ).toContain(
      'assignee = "Kim Roe" AND assignee not in ("acc-kim-busy") ORDER BY updated DESC',
    );
    expect(s.writes()).toHaveLength(0);
  });

  it("fails when nobody matches, and says what a ticket search cannot tell", async () => {
    const s = site();
    const err = await failure(comment("@[Zzyzx Nobody] hello", "--mention"));

    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toBe(
      "Mention not resolved, nothing was posted to TEAM-1: @[Zzyzx Nobody] matches nobody: no one on TEAM-1, and no assignee or reporter of a ticket this login can see, has exactly that full name",
    );
    expect(err.suggestions).toEqual([
      "A ticket search cannot tell an unknown person from one with no visible tickets, and it never matches part of a name - use their email @[name@example.com] or @[accountId:<id>] in place of @[Zzyzx Nobody]",
    ]);
    expect(s.writes()).toHaveLength(0);
  });

  it("does not resolve part of a name", async () => {
    const s = site();
    const err = await failure(comment("@[Jane] hello", "--mention"));
    expect(err.message).toContain("@[Jane] matches nobody");
    expect(s.writes()).toHaveLength(0);
  });

  it("reports every unresolved token at once and posts nothing", async () => {
    const s = site({ watchers: [SAM_A.accountId, SAM_B.accountId] });
    const err = await failure(
      comment("@[jane@acme.com] @[Sam Lee] @[Nobody Here]", "--mention"),
    );
    expect(err.message).toContain("@[Sam Lee] matches 2 people");
    expect(err.message).toContain("@[Nobody Here] matches nobody");
    expect(s.writes()).toHaveLength(0);
  });

  it("rejects a malformed account id", async () => {
    const s = site();
    const err = await failure(comment("@[accountId:not an id!] x", "--mention"));
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toContain("is not a usable account id");
    expect(s.writes()).toHaveLength(0);
  });

  it("names the edit instead of reprinting a body that came from a file", async () => {
    const s = site({ watchers: [SAM_A.accountId, SAM_B.accountId] });
    const dir = mkdtempSync(join(tmpdir(), "jira-axi-mention-"));
    const file = join(dir, "c.md");
    writeFileSync(file, "@[Sam Lee]\n\nplease look");
    try {
      const err = await failure(
        workitemCommand(["comment", "TEAM-1", "--body-file", file]),
      );
      expect(err.suggestions[0]).toBe(
        `Replace @[Sam Lee] with @[accountId:acc-sam-a] in ${file}, then run \`jira-axi workitem comment TEAM-1 --body-file '${file}'\` to mention Sam Lee (accountId acc-sam-a, watcher)`,
      );
      expect(s.writes()).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

describe("workitem comment mentions - guard", () => {
  it("refuses a mention without --mention, and the refusal is the preview", async () => {
    const s = site();
    const err = await failure(comment("@[jane@acme.com] ready for review"));

    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toBe(
      "Refusing to post without --mention. Nothing was posted to TEAM-1. This comment would notify 1 person: Jane Doe (accountId acc-jane, assignee)",
    );
    expect(err.suggestions[0]).toBe(
      "Run `jira-axi workitem comment TEAM-1 --body '@[jane@acme.com] ready for review' --mention` to post it and notify them",
    );
    expect(s.writes()).toHaveLength(0);
  });

  it("previews by name, never by email address", async () => {
    site();
    const err = await failure(comment("@[ravi@acme.com] @[jane@acme.com] hi"));
    expect(err.message).toContain("would notify 2 people");
    expect(err.message).toContain("Ravi Patel (accountId acc-ravi, reporter)");
    expect(err.message).not.toContain("acme.com");
  });

  it("guards a raw ADF body that carries a mention node", async () => {
    const s = site();
    const raw = JSON.stringify(para(text("hi "), mention("acc-jane")));
    const err = await failure(comment(raw));
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toContain(
      "would notify 1 person: Jane Doe (accountId acc-jane, assignee)",
    );
    expect(s.writes()).toHaveLength(0);

    await comment(raw, "--mention");
    expect(s.writes()).toHaveLength(1);
  });

  it("counts one person once when two tokens name them", async () => {
    site();
    const err = await failure(comment("@[jane@acme.com] and @[Jane Doe]"));
    expect(err.message).toContain("would notify 1 person");
  });

  it("caps the mentions in one comment, before reading anything", async () => {
    const s = site();
    const body = [1, 2, 3, 4, 5, 6].map((n) => `@[accountId:acc-${n}]`).join(" ");
    const err = await failure(comment(body, "--mention"));
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toContain(
      "this comment has 6 different @[...] mentions and the limit is 5 per comment. Nothing was posted to TEAM-1",
    );
    expect(s.calls).toHaveLength(0);
  });

  it("allows exactly the cap", async () => {
    const s = site();
    const body = [1, 2, 3, 4, 5].map((n) => `@[accountId:acc-${n}]`).join(" ");
    await comment(body, "--mention");
    expect(sentMentions(s)).toHaveLength(5);
  });

  it("does not swallow --mention as the body text", async () => {
    const s = site();
    const err = await failure(
      workitemCommand(["comment", "TEAM-1", "--body", "--mention"]),
    );
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toBe("--body requires text");
    expect(s.writes()).toHaveLength(0);
  });

  it("says so when --mention is passed but the body mentions nobody", async () => {
    const s = site();
    const out = await comment("no tags here", "--mention");
    expect(s.writes()).toHaveLength(1);
    expect(out).toContain(
      "mentions: none (the body has no @[...] mention, so nobody was notified)",
    );
  });
});

// ---------------------------------------------------------------------------
// What stays plain text
// ---------------------------------------------------------------------------

describe("workitem comment mentions - plain text", () => {
  it.each([
    ["a bare @Name", "@Zed Quill please look"],
    ["an email address in prose", "mail zed@acme.com about it"],
    ["@here", "@here deploy is done"],
    ["an escaped token", "\\@[jane@acme.com] is the syntax"],
    ["inline code", "write `@[jane@acme.com]` to tag"],
    ["a code block", "```\n@[jane@acme.com]\n```"],
    ["link text", "[@[jane@acme.com]](https://example.com)"],
    ["a word glued to the @", "user@[jane@acme.com]"],
  ])("posts %s as text with no --mention needed", async (_name, body) => {
    const s = site();
    const out = await comment(body);
    expect(s.writes()).toHaveLength(1);
    expect(sentMentions(s)).toEqual([]);
    expect(out).toContain("message: Comment added");
    expect(out).not.toContain("mentions");
  });

  it("stores the escape without its backslash", async () => {
    const s = site();
    await comment("\\@[jane@acme.com] is the syntax");
    expect(s.writes()[0].bodyFile).toEqual(
      para(text("@[jane@acme.com] is the syntax")),
    );
  });

  it("makes no extra acli call for a body with no @ at all", async () => {
    const s = site();
    await comment("Deployed to staging");
    expect(s.calls.map((c) => c.args.slice(2, 4).join(" "))).toEqual([
      "comment create",
      "view TEAM-1",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Post-write check
// ---------------------------------------------------------------------------

describe("workitem comment mentions - stored result", () => {
  it("fails loudly when the stored comment lacks the mention", async () => {
    const s = site({ stripMentionsOnWrite: true });
    const err = await failure(comment("@[jane@acme.com] ready", "--mention"));

    // Posted, but not as asked: a failure (exit 1), not a validation error.
    expect(err.code).toBe("UNKNOWN");
    expect(err.message).toBe(
      "Comment 5000 was posted to TEAM-1 but the STORED comment does not mention: Jane Doe (accountId acc-jane, assignee). They were NOT notified by it. Do not re-run: that would post it twice",
    );
    expect(err.suggestions).toEqual([
      "Run `jira-axi workitem view TEAM-1 --comments --full --limit 200` to read the stored comment",
    ]);
    expect(s.writes()).toHaveLength(1);
  });

  it("fails loudly when the new comment cannot be re-read", async () => {
    site({ hideNewComment: true });
    const err = await failure(comment("@[jane@acme.com] ready", "--mention"));
    expect(err.code).toBe("UNKNOWN");
    expect(err.message).toContain(
      "could not be re-read, so its mentions are NOT confirmed",
    );
  });

  it("reports what is stored, not what was asked for", async () => {
    const s = site({
      comments: [{ author: OTTO.accountId, body: para(text("earlier")) }],
    });
    const out = await comment("@[jane@acme.com] and @[Ravi Patel]", "--mention");
    expect(out).toContain(
      "mentions[2]{name,account}:\n  Jane Doe,acc-jane\n  Ravi Patel,acc-ravi",
    );
    // The earlier comment is not mistaken for the new one.
    expect(out).toContain("Comment added (id 5001)");
    expect(s.comments).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Bare @Name note
// ---------------------------------------------------------------------------

describe("workitem comment mentions - bare @Name note", () => {
  it("notes a bare @Name of someone on the ticket and shows the bracket form", async () => {
    const s = site();
    s.setAuthor(OTTO.accountId);
    const out = await comment("@Jane Doe Just bumping this");
    expect(s.writes()).toHaveLength(1);
    expect(out).toContain("message: Comment added");
    expect(out).toContain(
      "note: a bare @Name is stored as plain text and notifies nobody. To mention someone on this ticket write the bracket form and pass --mention: @[Jane Doe] for Jane Doe (accountId acc-jane, assignee)",
    );
  });

  it("notes a first name only one person on the ticket has", async () => {
    site();
    const out = await comment("thanks @ravi!");
    expect(out).toContain("@[Ravi Patel] for Ravi Patel (accountId acc-ravi, reporter)");
  });

  it("stays quiet for an email, a stranger, code, or a real mention", async () => {
    site();
    for (const body of [
      "mail jane@acme.com",
      "@Zed Quill hello",
      "`@Jane Doe` in code",
      "@Janet is someone else",
    ]) {
      expect(await comment(body)).not.toContain("note:");
    }
    expect(await comment("@[Jane Doe] done", "--mention")).not.toContain("note:");
  });
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe("reading mentions", () => {
  it("shows a stored mention as @Name in view --comments", async () => {
    const s = site({
      comments: [
        {
          author: OTTO.accountId,
          body: para(
            text("Hi "),
            mention("acc-jane", "@Jane Doe"),
            text(" & "),
            mention("acc-ravi", "@Ravi Patel"),
            text(" please see attached"),
          ),
        },
      ],
    });
    const out = await workitemCommand(["view", "TEAM-1", "--comments"]);
    expect(out).toContain("count: 1 of 1 total");
    expect(out).toContain(
      "Otto Berg,Hi @Jane Doe & @Ravi Patel please see attached",
    );
    // Read from the stored comment field, not acli's flattening `comment list`.
    expect(s.calls.some((c) => c.args[2] === "comment")).toBe(false);
  });

  it("shows a mention in the description, and an unnamed one by account id", async () => {
    site({
      description: para(
        text("Owner: "),
        mention("acc-jane", "@Jane Doe"),
        text(", backup: "),
        mention("acc-ravi"),
      ),
    });
    const out = await workitemCommand(["view", "TEAM-1"]);
    expect(out).toContain(
      'body: "Owner: @Jane Doe, backup: @[accountId:acc-ravi]"',
    );
  });

  it("honours --limit over the stored comments and reports the true total", async () => {
    site({
      comments: [1, 2, 3].map((n) => ({
        author: OTTO.accountId,
        body: para(text(`comment ${n}`)),
      })),
    });
    const out = await workitemCommand([
      "view",
      "TEAM-1",
      "--comments",
      "--limit",
      "2",
    ]);
    expect(out).toContain("count: 2 of 3 total (use --limit 3 for all)");
    expect(out).toContain("comment 2");
    expect(out).not.toContain("comment 3");
  });
});

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

describe("workitem comment mentions - help", () => {
  it("documents the syntax, the flag and the cap in `comment --help`", async () => {
    const out = await workitemCommand(["comment", "--help"]);
    expect(out).toContain("@[email], @[Full Name] or @[accountId:<id>]");
    expect(out).toContain("a bare @Name stays plain text");
    expect(out).toContain("--mention (required to post a body containing @[...]");
    expect(out).toContain("at most 5 mentions per comment");
    expect(out).toContain("\\@[ escapes a mention");
    expect(out).toContain(
      'jira-axi workitem comment TEAM-1 --body "@[jane@acme.com] ready for review" --mention',
    );
  });

  it("serves help, and posts nothing, for --help next to a mention", async () => {
    const s = site();
    const out = await workitemCommand([
      "comment",
      "TEAM-1",
      "--body",
      "@[jane@acme.com] hi",
      "--mention",
      "--help",
    ]);
    expect(out).toContain("usage: jira-axi workitem comment <KEY>");
    expect(s.calls).toHaveLength(0);
  });
});
