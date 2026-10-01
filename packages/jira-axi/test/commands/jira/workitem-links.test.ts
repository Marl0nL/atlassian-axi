import { afterEach, describe, expect, it } from "vitest";
import { setAcliRunner } from "../../../src/acli.js";
import { workitemCommand } from "../../../src/commands/jira/workitem.js";
import { makeAcliFake } from "../../helpers/acliFake.js";
import { makeLinkSite, type SiteLink } from "../../helpers/linkSite.js";
import { linksViewPayload } from "../../fixtures/acli.js";

afterEach(() => {
  setAcliRunner(null);
});

/** Run a workitem subcommand against a fake site; returns the site too. */
async function run(args: string[], site = makeLinkSite()) {
  setAcliRunner(site.runner);
  return { out: await workitemCommand(args), site };
}

const isLinksView = (key: string) => (args: string[]) =>
  args[2] === "view" && args[3] === key;

// TEAM-1 blocks TEAM-2 (in REST terms TEAM-1 is the link's inwardIssue).
const BLOCKS: SiteLink = {
  id: "10042",
  type: "Blocks",
  inward: "TEAM-1",
  outward: "TEAM-2",
};
// OPS-9 blocks TEAM-1, i.e. TEAM-1 is blocked by OPS-9.
const BLOCKED_BY: SiteLink = {
  id: "10043",
  type: "Blocks",
  inward: "OPS-9",
  outward: "TEAM-1",
};
// Stored with TEAM-1 on the outward end; "relates to" reads the same both ways.
const RELATES: SiteLink = {
  id: "10044",
  type: "Relates",
  inward: "OPS-9",
  outward: "TEAM-1",
};

// ---------------------------------------------------------------------------
// list-links
// ---------------------------------------------------------------------------

describe("workitem list-links", () => {
  it("renders each link from the listed item's point of view (contract snapshot)", async () => {
    const { runner, calls } = makeAcliFake([
      { match: isLinksView("TEAM-1"), result: linksViewPayload },
    ]);
    setAcliRunner(runner);

    const out = await workitemCommand(["list-links", "TEAM-1"]);
    expect(out).toMatchInlineSnapshot(`
      "count: 3
      reads: TEAM-1 <relation> <key>
      links[3]{relation,key,type,status,summary,id}:
        blocks,TEAM-2,Blocks,todo,Add audit log export,10042
        is blocked by,OPS-9,Blocks,wip,Rotate signing keys,10043
        relates to,OPS-3,Relates,done,"SSO outage, 12 July",10044
      help[2]:
        Run \`jira-axi workitem unlink TEAM-1 --id <id>\` to remove a link
        Run \`jira-axi workitem link TEAM-1 --to <KEY> --type <name|phrase>\` to add one"
    `);
    // One read of the item's `issuelinks` field - never acli's own `link
    // list`, whose JSON drops the other key for half the links.
    expect(calls.map((c) => c.args)).toEqual([
      [
        "jira",
        "workitem",
        "view",
        "TEAM-1",
        "--fields",
        "key,issuelinks",
        "--json",
      ],
    ]);
  });

  it("states a definitive empty result", async () => {
    const { out } = await run(["list-links", "TEAM-2"]);
    expect(out).toMatchInlineSnapshot(`
      "count: 0
      links: 0 work item links on TEAM-2
      help[2]:
        Run \`jira-axi workitem link TEAM-2 --to <KEY> --type <name|phrase>\` to add a link
        Run \`jira-axi workitem link-types\` to see the link types and their phrases"
    `);
  });

  it("slices client-side with --limit and names the way to see the rest", async () => {
    const { out } = await run(
      ["list-links", "TEAM-1", "--limit", "2"],
      makeLinkSite({ links: [BLOCKS, BLOCKED_BY, RELATES] }),
    );
    expect(out).toContain("count: 3 (showing first 2 — raise with --limit 3)");
    expect(out).toContain("links[2]{relation,key,type,status,summary,id}:");
  });

  it("uppercases the key", async () => {
    const { site } = await run(["list-links", "team-1"]);
    expect(site.callsOf("view")[0].args[3]).toBe("TEAM-1");
  });

  it("names the work item when it does not exist", async () => {
    setAcliRunner(makeLinkSite().runner);
    await expect(
      workitemCommand(["list-links", "TEAM-404"]),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("TEAM-404"),
    });
  });

  it("refuses to report 'no links' when acli did not return the field", async () => {
    setAcliRunner(makeLinkSite({ omitLinksField: true }).runner);
    await expect(
      workitemCommand(["list-links", "TEAM-1"]),
    ).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("did not return"),
    });
  });

  it("strips terminal control characters from remote link text", async () => {
    const { out } = await run(
      ["list-links", "TEAM-1"],
      makeLinkSite({
        items: {
          "TEAM-2": { summary: "evil\u009b31msummary", status: "To Do" },
        },
        links: [BLOCKS],
      }),
    );
    expect(out).not.toContain("\u009b");
    expect(out).toContain("evil31msummary");
  });

  it.each([
    [["list-links"], "Missing work item key"],
    [["list-links", "nokey"], "Invalid work item key"],
    [["list-links", "TEAM-1", "TEAM-2"], "Unexpected extra argument: TEAM-2"],
    [["list-links", "TEAM-1", "--limit", "lots"], "Invalid --limit"],
    [["list-links", "TEAM-1", "--json"], "Unknown flag: --json"],
  ])("rejects %j before any acli call", async (args, message) => {
    const site = makeLinkSite();
    setAcliRunner(site.runner);
    await expect(workitemCommand(args)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining(message),
    });
    expect(site.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// link-types
// ---------------------------------------------------------------------------

describe("workitem link-types", () => {
  it("lists every type with phrases read off real links (contract snapshot)", async () => {
    const { out, site } = await run(
      ["link-types"],
      makeLinkSite({
        typeNames: ["Blocks", "Relates"],
        links: [BLOCKS, RELATES],
      }),
    );
    expect(out).toMatchInlineSnapshot(`
      "count: 2
      types[2]{name,outward,inward}:
        Blocks,blocks,is blocked by
        Relates,relates to,relates to
      help[2]:
        Run \`jira-axi workitem link <KEY> --to <OTHER> --type <name>\` to link "<KEY> <outward> <OTHER>"
        Run \`jira-axi workitem link <KEY> --to <OTHER> --type "<inward phrase>"\` to link "<KEY> <inward> <OTHER>" (or \`--type <name> --reverse\`)"
    `);
    // acli's `link type` has names only; the phrases come from one work item
    // per type, found with a bounded JQL.
    expect(site.callsOf("link", "type")[0].args).toEqual([
      "jira",
      "workitem",
      "link",
      "type",
      "--json",
    ]);
    expect(site.callsOf("search")[0].args).toEqual([
      "jira",
      "workitem",
      "search",
      "--jql",
      'issueLinkType = "Blocks"',
      "--limit",
      "1",
      "--fields",
      "key,summary",
      "--json",
    ]);
  });

  it("falls back to Jira's default phrases, and says they are unconfirmed", async () => {
    const { out } = await run(
      ["link-types"],
      makeLinkSite({ typeNames: ["Blocks", "Duplicate"], links: [BLOCKS] }),
    );
    expect(out).toContain("Duplicate,duplicates,is duplicated by");
    expect(out).toContain(
      "note: phrases of Duplicate are Jira's defaults, unconfirmed on this site",
    );
    expect(out).not.toContain("phrases of Blocks");
  });

  it("reads a custom type's phrases live, and reports unknown when it cannot", async () => {
    const depends = {
      id: "10100",
      name: "Dependency",
      outward: "depends on",
      inward: "is required by",
      self: "https://example.atlassian.net/rest/api/3/issueLinkType/10100",
    };
    const { out } = await run(
      ["link-types"],
      makeLinkSite({
        typeNames: ["Dependency", "Tested"],
        types: { Dependency: depends },
        links: [
          { id: "1", type: "Dependency", inward: "TEAM-1", outward: "TEAM-2" },
        ],
      }),
    );
    expect(out).toContain("Dependency,depends on,is required by");
    expect(out).toContain("Tested,unknown,unknown");
    expect(out).toContain("note: phrases of Tested are unknown");
  });

  it("treats a failed phrase lookup as 'no evidence', not an error", async () => {
    const { runner } = makeAcliFake([
      {
        match: (args) => args[2] === "link" && args[3] === "type",
        result: { issueLinkTypes: [{ name: "Blocks" }] },
      },
      {
        match: (args) => args[2] === "search",
        result: { stdout: "", stderr: "✗ Error: boom", exitCode: 1 },
      },
    ]);
    setAcliRunner(runner);
    const out = await workitemCommand(["link-types"]);
    expect(out).toContain("Blocks,blocks,is blocked by");
    expect(out).toContain("phrases of Blocks are Jira's defaults");
  });

  it("states a definitive empty result", async () => {
    const { out } = await run(["link-types"], makeLinkSite({ typeNames: [] }));
    expect(out).toContain("count: 0");
    expect(out).toContain("types: 0 link types returned for this site");
  });

  it.each([
    [["link-types", "Blocks"], "Unexpected argument: Blocks"],
    [["link-types", "--limit", "5"], "Unknown flag: --limit"],
  ])("rejects %j before any acli call", async (args, message) => {
    const site = makeLinkSite();
    setAcliRunner(site.runner);
    await expect(workitemCommand(args)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining(message),
    });
    expect(site.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// link
// ---------------------------------------------------------------------------

describe("workitem link", () => {
  it("links by type NAME as '<KEY> <outward phrase> <--to>' (contract snapshot)", async () => {
    const { out, site } = await run([
      "link",
      "TEAM-1",
      "--to",
      "TEAM-2",
      "--type",
      "Blocks",
    ]);
    expect(out).toMatchInlineSnapshot(`
      "link:
        id: 20001
        relation: TEAM-1 blocks TEAM-2
        inverse: TEAM-2 is blocked by TEAM-1
        type: Blocks
        message: Linked
      help[2]:
        Run \`jira-axi workitem list-links TEAM-1\` to see all its links
        Run \`jira-axi workitem unlink TEAM-1 --id 20001\` to remove this link"
    `);
    // The item that DOES the blocking is acli's `--in` (REST inwardIssue).
    expect(site.callsOf("link", "create").map((c) => c.args)).toEqual([
      [
        "jira",
        "workitem",
        "link",
        "create",
        "--in",
        "TEAM-1",
        "--out",
        "TEAM-2",
        "--type",
        "Blocks",
        "--yes",
      ],
    ]);
    // And the other item really reads the inverse.
    const { out: other } = await run(["list-links", "TEAM-2"], site);
    expect(other).toContain("is blocked by,TEAM-1,Blocks");
  });

  it("matches the type name case-insensitively and sends the canonical name", async () => {
    const { out, site } = await run([
      "link",
      "team-1",
      "--to",
      "team-2",
      "--type",
      "relates",
    ]);
    expect(site.callsOf("link", "create")[0].args).toContain("Relates");
    expect(out).toContain("relation: TEAM-1 relates to TEAM-2");
    // A type name is the fast path: no phrase discovery.
    expect(site.callsOf("search")).toHaveLength(0);
  });

  it("--reverse swaps the two sides", async () => {
    const { out, site } = await run([
      "link",
      "TEAM-1",
      "--to",
      "TEAM-2",
      "--type",
      "Blocks",
      "--reverse",
    ]);
    expect(out).toContain("relation: TEAM-1 is blocked by TEAM-2");
    expect(out).toContain("inverse: TEAM-2 blocks TEAM-1");
    const args = site.callsOf("link", "create")[0].args;
    expect(args.slice(4, 8)).toEqual(["--in", "TEAM-2", "--out", "TEAM-1"]);
  });

  it("accepts the INWARD phrase as --type and reads it as written", async () => {
    const { out, site } = await run([
      "link",
      "TEAM-1",
      "--to",
      "TEAM-2",
      "--type",
      "is blocked by",
    ]);
    expect(out).toContain("relation: TEAM-1 is blocked by TEAM-2");
    expect(out).toContain("type: Blocks");
    const args = site.callsOf("link", "create")[0].args;
    expect(args.slice(4, 10)).toEqual([
      "--in",
      "TEAM-2",
      "--out",
      "TEAM-1",
      "--type",
      "Blocks",
    ]);
  });

  it("accepts the OUTWARD phrase as --type", async () => {
    const { out, site } = await run([
      "link",
      "TEAM-1",
      "--to",
      "TEAM-2",
      "--type",
      "Duplicates",
    ]);
    expect(out).toContain("relation: TEAM-1 duplicates TEAM-2");
    expect(site.callsOf("link", "create")[0].args.slice(4, 10)).toEqual([
      "--in",
      "TEAM-1",
      "--out",
      "TEAM-2",
      "--type",
      "Duplicate",
    ]);
  });

  it("resolves a custom type's phrase from a live link", async () => {
    const depends = {
      id: "10100",
      name: "Dependency",
      outward: "depends on",
      inward: "is required by",
      self: "https://example.atlassian.net/rest/api/3/issueLinkType/10100",
    };
    const { out } = await run(
      ["link", "TEAM-1", "--to", "TEAM-2", "--type", "is required by"],
      makeLinkSite({
        typeNames: ["Blocks", "Dependency"],
        types: { Dependency: depends },
        links: [
          { id: "1", type: "Dependency", inward: "OPS-9", outward: "TEAM-2" },
        ],
      }),
    );
    expect(out).toContain("relation: TEAM-1 is required by TEAM-2");
    expect(out).toContain("inverse: TEAM-2 depends on TEAM-1");
  });

  it("rejects --reverse with a phrase (the phrase already states the direction)", async () => {
    const site = makeLinkSite();
    setAcliRunner(site.runner);
    await expect(
      workitemCommand([
        "link",
        "TEAM-1",
        "--to",
        "TEAM-2",
        "--type",
        "is blocked by",
        "--reverse",
      ]),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("--reverse cannot be combined"),
    });
    expect(site.callsOf("link", "create")).toHaveLength(0);
  });

  it("is a no-op success when the link already exists", async () => {
    const { out, site } = await run(
      ["link", "TEAM-1", "--to", "TEAM-2", "--type", "Blocks"],
      makeLinkSite({ links: [BLOCKS] }),
    );
    expect(out).toContain("id: 10042");
    expect(out).toContain("relation: TEAM-1 blocks TEAM-2");
    expect(out).toContain("message: Already linked (no-op)");
    expect(site.callsOf("link", "create")).toHaveLength(0);
    expect(site.links).toHaveLength(1);
  });

  it("treats a symmetric type as already linked whichever end it was stored on", async () => {
    // RELATES is stored with TEAM-1 on the outward end.
    const { out, site } = await run(
      ["link", "TEAM-1", "--to", "OPS-9", "--type", "Relates"],
      makeLinkSite({ links: [RELATES] }),
    );
    expect(out).toContain("message: Already linked (no-op)");
    expect(site.callsOf("link", "create")).toHaveLength(0);
  });

  it("does NOT treat the opposite direction of an asymmetric type as the same link", async () => {
    // TEAM-1 is blocked by OPS-9; asking for TEAM-1 blocks OPS-9 is a new link.
    const { out, site } = await run(
      ["link", "TEAM-1", "--to", "OPS-9", "--type", "Blocks"],
      makeLinkSite({ links: [BLOCKED_BY] }),
    );
    expect(out).toContain("relation: TEAM-1 blocks OPS-9");
    expect(out).toContain("message: Linked");
    expect(site.links).toHaveLength(2);
  });

  it("rejects an unknown type with a did-you-mean and the valid types (exit 2)", async () => {
    const site = makeLinkSite({ links: [BLOCKS] });
    setAcliRunner(site.runner);
    const error = await workitemCommand([
      "link",
      "TEAM-1",
      "--to",
      "TEAM-2",
      "--type",
      "Bloks",
    ]).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "VALIDATION_ERROR",
      message: 'Unknown link type: "Bloks"',
    });
    const { suggestions } = error as { suggestions: string[] };
    expect(suggestions[0]).toBe("Did you mean `Blocks`?");
    expect(suggestions[1]).toContain("Blocks (blocks | is blocked by)");
    expect(suggestions[1]).toContain("Relates (relates to | relates to)");
    expect(site.callsOf("link", "create")).toHaveLength(0);
  });

  it("names the OTHER work item when it does not exist, before any write", async () => {
    const site = makeLinkSite();
    setAcliRunner(site.runner);
    await expect(
      workitemCommand([
        "link",
        "TEAM-1",
        "--to",
        "TEAM-404",
        "--type",
        "Blocks",
      ]),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("TEAM-404"),
    });
    expect(site.callsOf("link", "create")).toHaveLength(0);
  });

  it("names the work item itself when it does not exist", async () => {
    setAcliRunner(makeLinkSite().runner);
    await expect(
      workitemCommand([
        "link",
        "TEAM-404",
        "--to",
        "TEAM-2",
        "--type",
        "Blocks",
      ]),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("TEAM-404"),
    });
  });

  it("fails loudly when acli exits 0 without creating the link", async () => {
    setAcliRunner(makeLinkSite({ createIsNoop: true }).runner);
    await expect(
      workitemCommand(["link", "TEAM-1", "--to", "TEAM-2", "--type", "Blocks"]),
    ).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("Link was not created"),
    });
  });

  it("fails loudly, with the way back, if acli ever links the ends the other way round", async () => {
    setAcliRunner(makeLinkSite({ createSwapsEnds: true }).runner);
    const error = await workitemCommand([
      "link",
      "TEAM-1",
      "--to",
      "TEAM-2",
      "--type",
      "Blocks",
    ]).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining(
        'reads "TEAM-1 is blocked by TEAM-2", not the requested',
      ),
    });
    expect((error as { suggestions: string[] }).suggestions[0]).toBe(
      "Run `jira-axi workitem unlink TEAM-1 --id 20001` to remove it",
    );
  });

  it("checks a phrase against the REAL phrase when the site renamed a default type", async () => {
    // No work item uses Duplicate yet, so its phrases cannot be read live and
    // the shipped defaults are assumed - but this site swapped them.
    const renamed = {
      id: "10002",
      name: "Duplicate",
      outward: "is duplicated by",
      inward: "duplicates",
      self: "https://example.atlassian.net/rest/api/3/issueLinkType/10002",
    };
    setAcliRunner(makeLinkSite({ types: { Duplicate: renamed } }).runner);
    await expect(
      workitemCommand([
        "link",
        "TEAM-1",
        "--to",
        "TEAM-2",
        "--type",
        "duplicates",
      ]),
    ).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining(
        'reads "TEAM-1 is duplicated by TEAM-2", not the requested "duplicates"',
      ),
    });
  });

  it("maps an acli failure on create to a typed error", async () => {
    const site = makeLinkSite();
    setAcliRunner(async (args, stdin) =>
      args[2] === "link" && args[3] === "create"
        ? {
            stdout: "",
            stderr:
              "✗ Error: unauthorized: use 'acli jira auth login' to authenticate",
            exitCode: 1,
          }
        : site.runner(args, stdin),
    );
    await expect(
      workitemCommand(["link", "TEAM-1", "--to", "TEAM-2", "--type", "Blocks"]),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it.each([
    [["link"], "Missing work item key"],
    [["link", "TEAM-1"], "Missing required flags: --to, --type"],
    [["link", "TEAM-1", "--to", "TEAM-2"], "Missing required flags: --type"],
    [["link", "TEAM-1", "--type", "Blocks"], "Missing required flags: --to"],
    [["link", "TEAM-1", "--to", "", "--type", "Blocks"], 'Invalid --to: ""'],
    [["link", "TEAM-1", "--to", "nokey", "--type", "Blocks"], "Invalid --to"],
    [["link", "TEAM-1", "--to", "TEAM-2", "--type", " "], "--type"],
    [
      ["link", "TEAM-1", "--to", "team-1", "--type", "Blocks"],
      "Cannot link TEAM-1 to itself",
    ],
    [
      ["link", "TEAM-1", "TEAM-2", "--type", "Blocks"],
      "Unexpected extra argument: TEAM-2",
    ],
    [
      ["link", "TEAM-1", "--from", "TEAM-2", "--type", "Blocks"],
      "Unknown flag: --from",
    ],
    [["link", "TEAM-1", "--to", "--type", "Blocks"], "--to requires a value"],
  ])("rejects %j before any acli call", async (args, message) => {
    const site = makeLinkSite();
    setAcliRunner(site.runner);
    await expect(workitemCommand(args)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining(message),
    });
    expect(site.calls).toHaveLength(0);
  });

  it("lists the supported flags in the unknown-flag error", async () => {
    setAcliRunner(makeLinkSite().runner);
    await expect(
      workitemCommand(["link", "TEAM-1", "--too", "TEAM-2"]),
    ).rejects.toMatchObject({
      suggestions: expect.arrayContaining([
        "Supported flags: --to, --type, --reverse, --help",
      ]),
    });
  });
});

// ---------------------------------------------------------------------------
// unlink
// ---------------------------------------------------------------------------

describe("workitem unlink", () => {
  it("removes the one link to --from (contract snapshot)", async () => {
    const { out, site } = await run(
      ["unlink", "TEAM-1", "--from", "TEAM-2"],
      makeLinkSite({ links: [BLOCKS, BLOCKED_BY] }),
    );
    expect(out).toMatchInlineSnapshot(`
      "link:
        id: 10042
        relation: TEAM-1 blocks TEAM-2
        inverse: TEAM-2 is blocked by TEAM-1
        type: Blocks
        message: Unlinked
      help[1]:
        Run \`jira-axi workitem list-links TEAM-1\` to see its remaining links"
    `);
    expect(site.callsOf("link", "delete").map((c) => c.args)).toEqual([
      ["jira", "workitem", "link", "delete", "--id", "10042", "--yes"],
    ]);
    expect(site.links).toEqual([BLOCKED_BY]);
  });

  it("removes a link by --id", async () => {
    const { out, site } = await run(
      ["unlink", "TEAM-1", "--id", "10043"],
      makeLinkSite({ links: [BLOCKS, BLOCKED_BY] }),
    );
    expect(out).toContain("relation: TEAM-1 is blocked by OPS-9");
    expect(out).toContain("message: Unlinked");
    expect(site.links).toEqual([BLOCKS]);
  });

  it("is a no-op success when there is no link to --from", async () => {
    const { out, site } = await run(["unlink", "TEAM-1", "--from", "TEAM-2"]);
    expect(out).toMatchInlineSnapshot(`
      "link:
        message: Already unlinked - TEAM-1 has no link to TEAM-2 (no-op)
      help[1]:
        Run \`jira-axi workitem list-links TEAM-1\` to see its remaining links"
    `);
    expect(site.callsOf("link", "delete")).toHaveLength(0);
  });

  it("is a no-op success when --id is not a link on the work item", async () => {
    // 10043 exists, but between OPS-9 and TEAM-2: not TEAM-1's to delete.
    const stranger: SiteLink = {
      id: "10043",
      type: "Blocks",
      inward: "OPS-9",
      outward: "TEAM-2",
    };
    const { out, site } = await run(
      ["unlink", "TEAM-1", "--id", "10043"],
      makeLinkSite({ links: [BLOCKS, stranger] }),
    );
    expect(out).toContain(
      "message: Already unlinked - TEAM-1 has no link with id 10043 (no-op)",
    );
    expect(site.callsOf("link", "delete")).toHaveLength(0);
    expect(site.links).toHaveLength(2);
  });

  it("refuses to guess between several links, naming each (exit 2)", async () => {
    const site = makeLinkSite({ links: [BLOCKED_BY, RELATES] });
    setAcliRunner(site.runner);
    const error = await workitemCommand([
      "unlink",
      "TEAM-1",
      "--from",
      "OPS-9",
    ]).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "VALIDATION_ERROR",
      message:
        "2 links between TEAM-1 and OPS-9 match - is blocked by (Blocks, id 10043); relates to (Relates, id 10044)",
    });
    expect((error as { suggestions: string[] }).suggestions).toEqual([
      "Run `jira-axi workitem unlink TEAM-1 --id <id>` to remove exactly one",
      "Or narrow it: `jira-axi workitem unlink TEAM-1 --from OPS-9 --type <name|phrase>`",
    ]);
    expect(site.callsOf("link", "delete")).toHaveLength(0);
  });

  it("narrows by --type name", async () => {
    const { out, site } = await run(
      ["unlink", "TEAM-1", "--from", "OPS-9", "--type", "relates"],
      makeLinkSite({ links: [BLOCKED_BY, RELATES] }),
    );
    expect(out).toContain("id: 10044");
    expect(site.links).toEqual([BLOCKED_BY]);
  });

  it("narrows by --type phrase, read from the work item's side", async () => {
    // Both directions exist between TEAM-1 and OPS-9.
    const blocksOps: SiteLink = {
      id: "10050",
      type: "Blocks",
      inward: "TEAM-1",
      outward: "OPS-9",
    };
    const { out, site } = await run(
      ["unlink", "TEAM-1", "--from", "OPS-9", "--type", "is blocked by"],
      makeLinkSite({ links: [BLOCKED_BY, blocksOps] }),
    );
    expect(out).toContain("id: 10043");
    expect(site.links).toEqual([blocksOps]);
  });

  it("says what still links the two when --type matched nothing", async () => {
    const { out, site } = await run(
      ["unlink", "TEAM-1", "--from", "OPS-9", "--type", "Blocks"],
      makeLinkSite({ links: [RELATES] }),
    );
    expect(out).toMatchInlineSnapshot(`
      "link:
        message: Already unlinked - TEAM-1 has no Blocks link to OPS-9 (no-op)
        still_linked: TEAM-1 relates to OPS-9 (id 10044)
      help[1]:
        Run \`jira-axi workitem list-links TEAM-1\` to see its remaining links"
    `);
    expect(site.callsOf("link", "delete")).toHaveLength(0);
  });

  it("rejects a typo'd --type instead of calling it already unlinked", async () => {
    const site = makeLinkSite({ links: [BLOCKS] });
    setAcliRunner(site.runner);
    await expect(
      workitemCommand([
        "unlink",
        "TEAM-1",
        "--from",
        "TEAM-2",
        "--type",
        "Bloks",
      ]),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: 'Unknown link type: "Bloks"',
    });
    expect(site.callsOf("link", "delete")).toHaveLength(0);
  });

  it("fails loudly when acli exits 0 without removing the link", async () => {
    setAcliRunner(makeLinkSite({ links: [BLOCKS], deleteIsNoop: true }).runner);
    await expect(
      workitemCommand(["unlink", "TEAM-1", "--id", "10042"]),
    ).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("Link 10042 was not removed"),
    });
  });

  it.each([
    [["unlink"], "Missing work item key"],
    [["unlink", "TEAM-1"], "Missing --from <KEY> or --id <link id>"],
    [
      ["unlink", "TEAM-1", "--from", "TEAM-2", "--id", "10042"],
      "Use either --from or --id, not both",
    ],
    [
      ["unlink", "TEAM-1", "--id", "10042", "--type", "Blocks"],
      "--type only applies with --from",
    ],
    [["unlink", "TEAM-1", "--id", "abc"], "Invalid --id: abc"],
    [["unlink", "TEAM-1", "--from", "nokey"], "Invalid --from"],
    [["unlink", "TEAM-1", "--from", "TEAM-1"], "must be a different work item"],
    [
      ["unlink", "TEAM-1", "--from", "TEAM-2", "--type", ""],
      "--type requires a value",
    ],
    [["unlink", "TEAM-1", "TEAM-2"], "Unexpected extra argument: TEAM-2"],
    [["unlink", "TEAM-1", "--to", "TEAM-2"], "Unknown flag: --to"],
  ])("rejects %j before any acli call", async (args, message) => {
    const site = makeLinkSite({ links: [BLOCKS] });
    setAcliRunner(site.runner);
    await expect(workitemCommand(args)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining(message),
    });
    expect(site.calls).toHaveLength(0);
    expect(site.links).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

describe("workitem link suggestions", () => {
  /** The lines of the trailing `help[n]:` block. */
  const helpLines = (out: string) =>
    out
      .slice(out.lastIndexOf("help["))
      .split("\n")
      .slice(1)
      .map((line) => line.trim());

  // AXI: a `help[]` line is a next step the agent can run as printed (or a
  // template with <placeholders>) - never a legend or a tip. Explanations
  // belong in the content (`reads:`, `note:`) or in `--help`.
  it.each([
    ["list-links", ["list-links", "TEAM-1"]],
    ["list-links (empty)", ["list-links", "TEAM-2"]],
    ["link-types", ["link-types"]],
    ["link", ["link", "TEAM-1", "--to", "TEAM-2", "--type", "Blocks"]],
    ["link (no-op)", ["link", "TEAM-1", "--to", "OPS-9", "--type", "Relates"]],
    ["unlink", ["unlink", "TEAM-1", "--from", "OPS-9"]],
    ["unlink (no-op)", ["unlink", "TEAM-1", "--from", "TEAM-2"]],
  ])("every help line after `%s` is a runnable command", async (_name, args) => {
    const { out } = await run(args, makeLinkSite({ links: [RELATES] }));
    const lines = helpLines(out);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^Run `jira-axi workitem [a-z-]+( [^`]+)?` /);
    }
  });
});

describe("workitem link help", () => {
  it.each(["link", "unlink", "list-links", "link-types"])(
    "`%s --help` serves that subcommand's own help, with examples, without shelling out",
    async (sub) => {
      const site = makeLinkSite();
      setAcliRunner(site.runner);
      const out = await workitemCommand([sub, "--help"]);
      expect(out).toContain(`usage: jira-axi workitem ${sub}`);
      expect(out).toContain("examples[");
      expect(out).toContain(`jira-axi workitem ${sub}`);
      // Scoped: another subcommand's flags are not dumped alongside.
      expect(out).not.toContain("--jql");
      expect(site.calls).toHaveLength(0);
    },
  );

  it("spells out the direction rule in `link --help`", async () => {
    const out = await workitemCommand(["link", "--help"]);
    expect(out).toContain("--type Blocks   # TEAM-1 blocks TEAM-2");
    expect(out).toContain(
      '--type "is blocked by"   # TEAM-1 is blocked by TEAM-2',
    );
    expect(out).toContain("--type Blocks --reverse   # TEAM-2 blocks TEAM-1");
  });
});
