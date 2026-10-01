import { AxiError } from "@atlassian-axi/core";

/**
 * Per-subcommand help content for `workitem`. Single source of truth for both
 * the whole-resource `workitem --help` doc and the subcommand-scoped
 * `workitem <sub> --help` doc, so the two can never drift apart (the pattern
 * confluence-axi's `page` uses). `workitem` is deliberately NOT registered in
 * cli.ts's `COMMAND_HELP`: registering it makes the SDK swallow every deep
 * `workitem ... --help` with the whole-resource doc.
 */
type WorkitemSubcommandDoc = {
  /** Argument shape as it appears after `jira-axi workitem`. */
  readonly usage: string;
  readonly summary: string;
  /** One entry per flag. */
  readonly flags: readonly string[];
  /** First entry is the one the whole-resource doc shows. */
  readonly examples: readonly string[];
};

const WORKITEM_SUBCOMMAND_DOCS = {
  list: {
    usage: "list",
    summary:
      "List work items (builds JQL from the filters; no filters => updated >= -30d window).",
    flags: [
      "--jql <query> (verbatim; exclusive with the filters below)",
      "--project <KEY>",
      "--assignee <email|@me>",
      "--status <name>",
      "--limit <n> (default 30)",
      "--fields <a,b,c> (no filters => updated >= -30d window; acli rejects unbounded JQL)",
    ],
    examples: ['jira-axi workitem list --project TEAM --status "In Progress"'],
  },
  view: {
    usage: "view <KEY>",
    summary:
      "Show one work item (its `links` row is a count plus an inline summary).",
    flags: [
      "--comments",
      "--links (list its links: relation, key, type, status, summary, id)",
      "--limit <n> (comments/links shown, default 30; requires --comments or --links)",
      "--full (complete bodies without truncation)",
      "--fields <a,b,c> (render only these fields; key is always included)",
    ],
    examples: [
      "jira-axi workitem view TEAM-1 --comments",
      "jira-axi workitem view TEAM-1 --links",
      "jira-axi workitem view TEAM-1 --fields summary,status,links",
    ],
  },
  create: {
    usage: "create",
    summary: "Create a work item, then render it.",
    flags: [
      "--project <KEY> (required)",
      "--type <name> (required)",
      "--summary <text> (required)",
      "--parent <KEY> (place under an epic/parent work item)",
      "--body <text> or --body-file <path> (markdown description, stored as ADF)",
      "--assignee <email|@me>",
      "--label <a,b>",
    ],
    examples: [
      'jira-axi workitem create --project TEAM --type Task --summary "Fix login"',
      'jira-axi workitem create --project TEAM --type Task --summary "Sub-task" --parent TEAM-1',
    ],
  },
  edit: {
    usage: "edit <KEY>",
    summary: "Edit a work item, then render it.",
    flags: [
      "--summary <text>",
      "--body <text> or --body-file <path> (markdown description, stored as ADF)",
      "--assignee <email|@me>",
      "--type <name>",
      "--labels <a,b>",
      "--remove-labels <a,b> (note: parent/epic is set at create time via --parent and CANNOT be changed here - acli's edit has no parent field)",
    ],
    examples: ['jira-axi workitem edit TEAM-1 --summary "New title"'],
  },
  transition: {
    usage: "transition <KEY>",
    summary: "Move a work item to a status (idempotent).",
    flags: ["--to <status> (required; no-op success when already there)"],
    examples: ["jira-axi workitem transition TEAM-1 --to Done"],
  },
  assign: {
    usage: "assign <KEY>",
    summary: "Assign a work item (idempotent for a concrete user).",
    flags: ["--assignee <email|@me> (required)"],
    examples: ["jira-axi workitem assign TEAM-1 --assignee @me"],
  },
  comment: {
    usage: "comment <KEY>",
    summary: "Add a comment to a work item.",
    flags: [
      "--body <text> or --body-file <path> (required; markdown, stored as ADF)",
    ],
    examples: ['jira-axi workitem comment TEAM-1 --body "Deployed to staging"'],
  },
  search: {
    usage: 'search "<JQL>"',
    summary: "Run a verbatim JQL query.",
    flags: ["--limit <n> (default 30)", "--fields <a,b,c>"],
    examples: [
      'jira-axi workitem search "assignee = currentUser() AND resolution = EMPTY"',
    ],
  },
  link: {
    usage: "link <KEY> --to <KEY> --type <name|phrase>",
    summary:
      'Link two work items (idempotent). The link reads as a sentence, "<KEY> <phrase> <--to KEY>", and the output prints it both ways.',
    flags: [
      "--to <KEY> (required; the other work item)",
      '--type <name|phrase> (required; a type NAME uses its outward phrase: Blocks => "<KEY> blocks <--to>"; a PHRASE is read as written: "is blocked by" => "<KEY> is blocked by <--to>"; see `link-types`)',
      "--reverse (with a type NAME: swap the two sides)",
    ],
    examples: [
      "jira-axi workitem link TEAM-1 --to TEAM-2 --type Blocks   # TEAM-1 blocks TEAM-2",
      'jira-axi workitem link TEAM-1 --to TEAM-2 --type "is blocked by"   # TEAM-1 is blocked by TEAM-2',
      "jira-axi workitem link TEAM-1 --to TEAM-2 --type Blocks --reverse   # TEAM-2 blocks TEAM-1",
    ],
  },
  unlink: {
    usage: "unlink <KEY> --from <KEY> | --id <n>",
    summary:
      "Remove a link from a work item (idempotent: an absent link is a no-op success). Pass --from or --id.",
    flags: [
      "--from <KEY> (the other work item; removes the link between the two)",
      "--type <name|phrase> (with --from: narrow it when the two share several links)",
      "--id <n> (a link id from `list-links`; must be a link on <KEY>)",
    ],
    examples: [
      "jira-axi workitem unlink TEAM-1 --from TEAM-2",
      "jira-axi workitem unlink TEAM-1 --from TEAM-2 --type Blocks",
      "jira-axi workitem unlink TEAM-1 --id 10042",
    ],
  },
  "list-links": {
    usage: "list-links <KEY>",
    summary:
      'List a work item\'s links. Each row reads "<KEY> <relation> <key>"; `id` is what `unlink --id` takes.',
    flags: ["--limit <n> (default 30)"],
    examples: ["jira-axi workitem list-links TEAM-1"],
  },
  "link-types": {
    usage: "link-types",
    summary:
      "List the site's link types with their outward/inward phrases (what `link --type` accepts).",
    flags: [],
    examples: ["jira-axi workitem link-types"],
  },
} as const satisfies Record<string, WorkitemSubcommandDoc>;

export type WorkitemSubcommand = keyof typeof WORKITEM_SUBCOMMAND_DOCS;

export const WORKITEM_SUBCOMMANDS = Object.keys(
  WORKITEM_SUBCOMMAND_DOCS,
) as WorkitemSubcommand[];

function buildWorkitemHelp(): string {
  const lines = [
    "usage: jira-axi workitem <subcommand> [flags]",
    `subcommands[${WORKITEM_SUBCOMMANDS.length}]:`,
    `  ${WORKITEM_SUBCOMMANDS.map((name) => WORKITEM_SUBCOMMAND_DOCS[name].usage).join(", ")}`,
  ];
  for (const name of WORKITEM_SUBCOMMANDS) {
    const { flags } = WORKITEM_SUBCOMMAND_DOCS[name];
    if (flags.length > 0) {
      lines.push(`flags{${name}}:`, `  ${flags.join(", ")}`);
    }
  }
  lines.push("examples:");
  for (const name of WORKITEM_SUBCOMMANDS) {
    lines.push(`  ${WORKITEM_SUBCOMMAND_DOCS[name].examples[0]}`);
  }
  lines.push(
    "help[1]:",
    "  Run `jira-axi workitem <subcommand> --help` for one subcommand's flags and examples",
  );
  return lines.join("\n");
}

/** Whole-resource help, served for bare `jira-axi workitem` and `--help`. */
export const WORKITEM_HELP = buildWorkitemHelp();

/** Help for one subcommand, served for `jira-axi workitem <sub> --help`. */
export function workitemHelp(sub: WorkitemSubcommand): string {
  const doc: WorkitemSubcommandDoc = WORKITEM_SUBCOMMAND_DOCS[sub];
  return [
    `usage: jira-axi workitem ${doc.usage}${doc.flags.length > 0 ? " [flags]" : ""}`,
    doc.summary,
    ...(doc.flags.length > 0
      ? [`flags[${doc.flags.length}]:`, ...doc.flags.map((flag) => `  ${flag}`)]
      : []),
    `examples[${doc.examples.length}]:`,
    ...doc.examples.map((example) => `  ${example}`),
    "help[1]:",
    `  Run \`jira-axi workitem --help\` for all ${WORKITEM_SUBCOMMANDS.length} workitem subcommands`,
  ].join("\n");
}

const HELP_TOKENS: readonly string[] = ["--help", "-h"];

function isWorkitemSubcommand(sub: string): sub is WorkitemSubcommand {
  return Object.prototype.hasOwnProperty.call(WORKITEM_SUBCOMMAND_DOCS, sub);
}

/**
 * The help gate every `workitem <sub>` invocation passes BEFORE its handler
 * runs: a `--help`/`-h` token ANYWHERE after the subcommand returns that
 * subcommand's help and nothing else happens - no read, no write.
 *
 * This is deliberately position-blind. Because `workitem` owns its own help
 * (it is not in the SDK's COMMAND_HELP), nothing upstream intercepts
 * `comment TEAM-1 --body --help`; left to the handler, the body flag would
 * consume `--help` as its VALUE and post that text to a real ticket. A token
 * that is exactly `--help` or `-h` is therefore never a value: it is always a
 * help request, on reads and mutations alike.
 *
 * The `--flag=--help` spelling is the one case where the caller plainly meant
 * a value, so it is not served as help - but it must not reach Jira either:
 * it is refused (exit 2) with the way to send such text on purpose.
 *
 * Returns the help text to print, or `undefined` to carry on. An unknown
 * subcommand is left to the dispatcher's did-you-mean error.
 */
export function workitemHelpRequest(
  args: readonly string[],
): string | undefined {
  const sub = args[0];
  if (sub === undefined || !isWorkitemSubcommand(sub)) return undefined;
  const rest = args.slice(1);
  if (rest.some((arg) => HELP_TOKENS.includes(arg))) return workitemHelp(sub);

  const smuggled = rest.find((arg) => {
    const equals = arg.indexOf("=");
    return (
      arg.startsWith("--") &&
      equals !== -1 &&
      HELP_TOKENS.includes(arg.slice(equals + 1))
    );
  });
  if (smuggled !== undefined) {
    const flag = smuggled.slice(0, smuggled.indexOf("="));
    const value = smuggled.slice(smuggled.indexOf("=") + 1);
    throw new AxiError(
      `Refusing ${flag}=${value}: a value of exactly ${value} is never sent to Jira (it reads as a help request)`,
      "VALIDATION_ERROR",
      [
        `Run \`jira-axi workitem ${sub} --help\` for this subcommand's help`,
        "To store that literal text, put it in a file and pass --body-file <path> (where the subcommand takes a body)",
      ],
    );
  }
  return undefined;
}
