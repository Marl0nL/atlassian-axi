import type { AcliRunner, ExecResult } from "../../src/acli.js";
import { LINK_TYPE_OBJECTS, linkedIssue } from "../fixtures/acli.js";
import type { AcliCall } from "./acliFake.js";

/**
 * A tiny in-memory Jira for link tests: a stateful fake `acli` that answers
 * exactly the invocations the link commands make (`link type`, `view KEY
 * --fields ...issuelinks`, `search --jql issueLinkType = ...`, `link create`,
 * `link delete`) and fails loudly on anything else.
 *
 * A link is stored the way Jira's REST model stores it - one `inward` and one
 * `outward` work item - and the semantics below are the ones observed on a
 * live site (see the provenance header in fixtures/acli.ts):
 *
 *   - `link create --in X --out Y` stores {inward: X, outward: Y};
 *   - viewing X then shows the entry with `outwardIssue: Y`, which Jira reads
 *     "X <outward phrase> Y"; viewing Y shows `inwardIssue: X`, read
 *     "Y <inward phrase> X".
 *
 * So a test asserting "TEAM-1 blocks TEAM-2" exercises the CLI's --in/--out
 * choice against the real direction rule, not merely against its own argv.
 */
export interface SiteLink {
  id: string;
  type: string;
  /** The link's REST `inwardIssue`: the item that "<outward phrase>"s. */
  inward: string;
  /** The link's REST `outwardIssue`. */
  outward: string;
}

interface SiteItem {
  summary: string;
  status: string;
}

type LinkTypeObject = (typeof LINK_TYPE_OBJECTS)[string];

export interface LinkSiteOptions {
  /** Work items that exist; any other key 404s like the live site does. */
  items?: Record<string, SiteItem>;
  links?: SiteLink[];
  /** Type names `link type` returns (defaults to the five shipped types). */
  typeNames?: string[];
  /** Extra/overriding type objects (custom types, renamed phrases). */
  types?: Record<string, LinkTypeObject>;
  /** `link create` exits 0 but creates nothing. */
  createIsNoop?: boolean;
  /** `link create` stores the two ends swapped (a future acli drift). */
  createSwapsEnds?: boolean;
  /** `link delete` exits 0 but deletes nothing. */
  deleteIsNoop?: boolean;
  /** Drop the `issuelinks` field from view output (acli shape drift). */
  omitLinksField?: boolean;
}

const NOT_FOUND: ExecResult = {
  stdout: "",
  stderr:
    "✗ Error: Issue does not exist or you do not have permission to see it.",
  exitCode: 1,
};

const ok = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
});
const json = (value: unknown): ExecResult => ok(JSON.stringify(value));
const flag = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

export function makeLinkSite(options: LinkSiteOptions = {}) {
  const items: Record<string, SiteItem> = {
    "TEAM-1": { summary: "Fix login redirect loop", status: "In Progress" },
    "TEAM-2": { summary: "Add audit log export", status: "To Do" },
    "OPS-9": { summary: "Rotate signing keys", status: "Done" },
    ...options.items,
  };
  const types: Record<string, LinkTypeObject> = {
    ...LINK_TYPE_OBJECTS,
    ...options.types,
  };
  const typeNames = options.typeNames ?? Object.keys(LINK_TYPE_OBJECTS);
  const links: SiteLink[] = [...(options.links ?? [])];
  const calls: AcliCall[] = [];
  let nextId = 20001;

  const other = (key: string) =>
    linkedIssue(key, items[key]?.summary ?? key, items[key]?.status ?? "To Do");

  const issuelinksOf = (key: string) =>
    links
      .filter((link) => link.inward === key || link.outward === key)
      .map((link) => ({
        id: link.id,
        self: `https://example.atlassian.net/rest/api/3/issueLink/${link.id}`,
        type: types[link.type],
        ...(link.inward === key
          ? { outwardIssue: other(link.outward) }
          : { inwardIssue: other(link.inward) }),
      }));

  const view = (args: string[]): ExecResult => {
    const key = args[3];
    if (!items[key]) return NOT_FOUND;
    const fields = (flag(args, "--fields") ?? "").split(",");
    return json({
      fields: {
        ...(fields.includes("summary") ? { summary: items[key].summary } : {}),
        ...(fields.includes("issuelinks") && !options.omitLinksField
          ? { issuelinks: issuelinksOf(key) }
          : {}),
      },
      id: `9${key.replace(/\D/g, "")}`,
      key,
    });
  };

  const search = (args: string[]): ExecResult => {
    const match = /^issueLinkType = "(.*)"$/.exec(flag(args, "--jql") ?? "");
    if (!match) throw new Error(`Unexpected JQL: ${flag(args, "--jql")}`);
    const hit = links.find((link) => link.type === match[1]);
    return json(
      hit
        ? [{ key: hit.inward, fields: { summary: items[hit.inward]?.summary } }]
        : [],
    );
  };

  const create = (args: string[]): ExecResult => {
    const [inward, outward, type] = [
      flag(args, "--in"),
      flag(args, "--out"),
      flag(args, "--type"),
    ];
    if (!inward || !outward || !type || !args.includes("--yes")) {
      throw new Error(`Malformed link create: ${args.join(" ")}`);
    }
    if (!options.createIsNoop) {
      links.push(
        options.createSwapsEnds
          ? { id: String(nextId++), type, inward: outward, outward: inward }
          : { id: String(nextId++), type, inward, outward },
      );
    }
    return ok(
      `✓ Link between issues has been successfully created (${outward} ${type} ${inward})\n`,
    );
  };

  const remove = (args: string[]): ExecResult => {
    const id = flag(args, "--id");
    if (!id || !args.includes("--yes")) {
      throw new Error(`Malformed link delete: ${args.join(" ")}`);
    }
    const index = links.findIndex((link) => link.id === id);
    if (index !== -1 && !options.deleteIsNoop) links.splice(index, 1);
    // Placeholder text: acli's real delete output was never captured.
    return ok(`✓ Link ${id} deleted\n`);
  };

  const runner: AcliRunner = async (args, stdin) => {
    calls.push({ args, stdin });
    const [, resource, verb, sub] = args;
    if (resource !== "workitem") {
      throw new Error(`Unexpected acli invocation: ${args.join(" ")}`);
    }
    if (verb === "view") return view(args);
    if (verb === "search") return search(args);
    if (verb === "link" && sub === "type") {
      return json({ issueLinkTypes: typeNames.map((name) => ({ name })) });
    }
    if (verb === "link" && sub === "create") return create(args);
    if (verb === "link" && sub === "delete") return remove(args);
    throw new Error(`Unexpected acli invocation: ${args.join(" ")}`);
  };

  /** Calls of one kind, e.g. `callsOf("link", "create")`. */
  const callsOf = (verb: string, sub?: string) =>
    calls.filter(
      (call) =>
        call.args[2] === verb && (sub === undefined || call.args[3] === sub),
    );

  return { runner, calls, callsOf, links };
}
