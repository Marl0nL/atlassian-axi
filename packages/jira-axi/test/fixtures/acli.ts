/**
 * Recorded-contract fixtures for acli `--json` payloads (scout report risk R3).
 *
 * PROVENANCE: captured LIVE from acli v1.3.22-stable on 2026-07-14 against a
 * real authenticated Jira Cloud site, then anonymized (keys, names, summaries
 * and hosts replaced; structure, field sets, and value formats preserved
 * verbatim). Verified facts baked into these shapes:
 *  - `workitem search --json` returns a bare ARRAY of REST-shaped issues with
 *    `key` top-level and the rest under `fields`; the default field set is
 *    issuetype/key/assignee/priority/status/summary, and the --fields
 *    whitelist REJECTS `updated` ("field 'updated' is not allowed").
 *  - `workitem view --json` returns ONE object; created/updated/priority are
 *    only present when requested via --fields; timestamps use a numeric
 *    offset like "+0200"; description is an ADF document.
 *  - `workitem comment list --json` returns {comments, isLast, maxResults,
 *    startAt, total}; each comment is {id, author, body, visibility} with
 *    author and body as PLAIN STRINGS (no created timestamp, no ADF).
 *  - `project list --json` returns a bare ARRAY; `project view --json` one
 *    flat object; both carry projectTypeKey/style and lead.displayName.
 *
 * If a future acli version disagrees, re-capture and update these together
 * with the tolerant accessors in src/commands/jira/shared.ts.
 *
 * Timestamps are fixed; tests freeze the clock at FROZEN_NOW so relative-time
 * output stays deterministic.
 */

export const FROZEN_NOW = "2026-07-14T12:00:00.000Z";

/** `acli jira workitem search --jql ... --json` — bare array, default fields. */
export const searchPayload = [
  {
    changelog: null,
    editmeta: null,
    expand:
      "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations",
    fields: {
      assignee: {
        accountId: "5b10a2844c20165700ede21g",
        accountType: "atlassian",
        active: true,
        displayName: "Jane Doe",
        emailAddress: "jane@acme.com",
        self: "https://example.atlassian.net/rest/api/3/user?accountId=5b10a2844c20165700ede21g",
      },
      issuetype: {
        description: "A problem which impairs product functions.",
        hierarchyLevel: 0,
        id: "10607",
        name: "Bug",
        self: "https://example.atlassian.net/rest/api/3/issuetype/10607",
        subtask: false,
      },
      priority: {
        id: "10000",
        name: "High",
        self: "https://example.atlassian.net/rest/api/3/priority/10000",
      },
      status: {
        description: "Work is actively underway.",
        id: "3",
        name: "In Progress",
        self: "https://example.atlassian.net/rest/api/3/status/3",
        statusCategory: {
          colorName: "yellow",
          id: 4,
          key: "indeterminate",
          name: "In Progress",
          self: "https://example.atlassian.net/rest/api/3/statuscategory/4",
        },
      },
      summary: "Fix login redirect loop",
    },
    fieldsToInclude: null,
    id: "10001",
    key: "TEAM-1",
    names: null,
    operations: null,
    properties: null,
    renderedFields: null,
    schema: null,
    self: "https://example.atlassian.net/rest/api/3/issue/10001",
    transitions: null,
    versionedRepresentations: null,
  },
  {
    expand:
      "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations",
    fields: {
      assignee: null,
      issuetype: {
        id: "10002",
        name: "Task",
        self: "https://example.atlassian.net/rest/api/3/issuetype/10002",
        subtask: false,
      },
      priority: {
        id: "10001",
        name: "Medium",
        self: "https://example.atlassian.net/rest/api/3/priority/10001",
      },
      status: {
        id: "1",
        name: "To Do",
        self: "https://example.atlassian.net/rest/api/3/status/1",
        statusCategory: {
          colorName: "blue-gray",
          id: 2,
          key: "new",
          name: "To Do",
          self: "https://example.atlassian.net/rest/api/3/statuscategory/2",
        },
      },
      summary: "Add audit log export",
    },
    id: "10002",
    key: "TEAM-2",
    self: "https://example.atlassian.net/rest/api/3/issue/10002",
  },
];

/** `acli jira workitem view KEY --fields ... --json` — one object, full fields. */
export const viewPayload = {
  expand:
    "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations",
  fields: {
    assignee: {
      accountId: "5b10a2844c20165700ede21g",
      accountType: "atlassian",
      active: true,
      displayName: "Jane Doe",
      emailAddress: "jane@acme.com",
    },
    created: "2026-07-01T09:00:00.000+0200",
    description: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Login loops back to the SSO page." },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Repro: log in with a fresh session." }],
        },
      ],
    },
    // An item without links returns an EMPTY array, not an absent field
    // (verified live, acli v1.3.30, when `issuelinks` is requested).
    issuelinks: [],
    issuetype: { id: "10607", name: "Bug", subtask: false },
    priority: { id: "10000", name: "High" },
    status: {
      id: "3",
      name: "In Progress",
      statusCategory: { id: 4, key: "indeterminate", name: "In Progress" },
    },
    summary: "Fix login redirect loop",
    updated: "2026-07-13T12:00:00.000+0200",
  },
  id: "10001",
  key: "TEAM-1",
  self: "https://example.atlassian.net/rest/api/3/issue/10001",
};

/** Same work item after `transition --status Done`, for post-mutation re-fetch. */
export const viewPayloadDone = {
  ...viewPayload,
  fields: {
    ...viewPayload.fields,
    status: {
      id: "6",
      name: "Done",
      statusCategory: { id: 3, key: "done", name: "Done" },
    },
    updated: "2026-07-14T13:59:00.000+0200",
  },
};

/** `acli jira workitem comment list --key KEY --json` — flat string comments. */
export const commentListPayload = {
  comments: [
    {
      author: "Jane Doe",
      body: "Reproduced on staging.",
      id: "20001",
      visibility: "public",
    },
    {
      author: "John Smith",
      body: "Plain-text comments also occur.",
      id: "20002",
      visibility: "public",
    },
  ],
  isLast: true,
  maxResults: 50,
  startAt: 0,
  total: 2,
};

/** `acli jira workitem create ... --json` — REST create response (id/key/self). */
export const createPayload = {
  id: "10003",
  key: "TEAM-3",
  self: "https://example.atlassian.net/rest/api/3/issue/10003",
};

/** The created item as `view TEAM-3 --fields ... --json` returns it. */
export const viewCreatedPayload = {
  fields: {
    assignee: null,
    created: "2026-07-14T13:58:00.000+0200",
    description: "Created from atlassian-axi",
    issuelinks: [],
    issuetype: { id: "10002", name: "Task", subtask: false },
    priority: { id: "10001", name: "Medium" },
    status: {
      id: "1",
      name: "To Do",
      statusCategory: { id: 2, key: "new", name: "To Do" },
    },
    summary: "New task from CLI",
    updated: "2026-07-14T13:58:00.000+0200",
  },
  id: "10003",
  key: "TEAM-3",
  self: "https://example.atlassian.net/rest/api/3/issue/10003",
};

/**
 * A created item that DOES sit under an epic, as `view --json` returns it: the
 * REST `parent` object carries the epic key (collapsed to "TEAM-1" by nameOf).
 *
 * DERIVED, not live-captured: built from `viewCreatedPayload` plus a `parent`
 * object shaped per the Jira REST v3 issue contract (this sits under the
 * live-capture provenance header above, so its synthetic origin is called out
 * here).
 */
export const viewParentedPayload = {
  fields: {
    ...viewCreatedPayload.fields,
    parent: {
      id: "10001",
      key: "TEAM-1",
      fields: {
        summary: "Epic: authentication",
        issuetype: { id: "10000", name: "Epic", subtask: false },
      },
    },
  },
  id: "10003",
  key: "TEAM-3",
  self: "https://example.atlassian.net/rest/api/3/issue/10003",
};

/** `acli jira project list --json` — bare array of flat REST projects. */
export const projectListPayload = [
  {
    archived: null,
    avatarUrls: {},
    description: "Main delivery project",
    id: "10000",
    isPrivate: false,
    key: "TEAM",
    lead: {
      accountId: "62beca8b174792b4ae0aa763",
      active: true,
      displayName: "Jane Doe",
      self: "https://example.atlassian.net/rest/api/3/user?accountId=62beca8b174792b4ae0aa763",
    },
    name: "Team Project",
    projectTypeKey: "software",
    self: "https://example.atlassian.net/rest/api/3/project/10000",
    simplified: false,
    style: "classic",
  },
  {
    id: "10100",
    key: "OPS",
    lead: { accountId: "5c00aa11bb22cc33dd44ee55", displayName: "John Smith" },
    name: "Operations",
    projectTypeKey: "service_desk",
    self: "https://example.atlassian.net/rest/api/3/project/10100",
    style: "classic",
  },
];

/** `acli jira project view --key TEAM --json` — one flat REST project. */
export const projectViewPayload = {
  archived: null,
  assigneeType: "UNASSIGNED",
  avatarUrls: {},
  description: "Main delivery project",
  id: "10000",
  isPrivate: false,
  key: "TEAM",
  lead: {
    accountId: "62beca8b174792b4ae0aa763",
    active: true,
    displayName: "Jane Doe",
  },
  name: "Team Project",
  projectTypeKey: "software",
  self: "https://example.atlassian.net/rest/api/3/project/10000",
  simplified: false,
  style: "classic",
};

// ---------------------------------------------------------------------------
// Phase 4a fixtures: board / sprint / filter / dashboard / field.
//
// PROVENANCE: read payloads (board search/view/list-sprints/list-projects,
// sprint view/list-workitems, filter search/view, dashboard search) captured
// LIVE from acli v1.3.22-stable on 2026-07-15 against a real authenticated
// Jira Cloud site, then anonymized (ids kept realistic, names/hosts/keys
// replaced). Mutation payloads (sprint create, filter list values, field
// create) are HAND-AUTHORED from the published Jira REST contracts - the
// commands could not be run against the production site. Verified facts:
//  - `board search --json` returns {isLast, maxResults, startAt, total,
//    values: [{id:number, location, name, type}]}; `board view --json` one
//    flat object with an extra `link`.
//  - `board list-sprints --json` wraps sprints under a `sprints` key (NOT
//    `values`); `board list-projects --json` under `projects` (id is a
//    STRING there, `type` not `projectTypeKey`).
//  - `sprint view --json` is one flat agile-REST sprint; completeDate only
//    appears on closed sprints; goal may be "".
//  - `sprint list-workitems --json` wraps REST-shaped issues (key + fields)
//    under `issues`; default fields are key,issuetype,summary,assignee,
//    priority,status.
//  - `filter search --json` and `dashboard search --json` return bare ARRAYS
//    of {id:string, name, description, owner}; `filter view --json` adds
//    jql/favourite/favouritedCount; `filter list --json` wraps under
//    `values` (observed empty live; entry shape assumed = view shape).
//
// If a future acli version disagrees, re-capture and update these together
// with the schemas in src/commands/jira/{board,sprint,filter,dashboard}.ts.
// ---------------------------------------------------------------------------

/** `acli jira board search --json` — {values} envelope with total. */
export const boardSearchPayload = {
  isLast: false,
  maxResults: 30,
  startAt: 0,
  total: 35,
  values: [
    {
      id: 1013,
      location: "Team Project (TEAM)",
      name: "Team Scrum",
      type: "scrum",
    },
    {
      id: 1333,
      location: "Operations (OPS)",
      name: "Ops Kanban",
      type: "kanban",
    },
  ],
};

/** `acli jira board view --id 1013 --json` — one flat board. */
export const boardViewPayload = {
  id: 1013,
  link: "https://example.atlassian.net/rest/agile/1.0/board/1013",
  location: "Team Project (TEAM)",
  name: "Team Scrum",
  type: "scrum",
};

/** `acli jira board list-sprints --id 1013 --json` — sprints under `sprints`. */
export const boardSprintsPayload = {
  isLast: false,
  maxResults: 30,
  startAt: 0,
  total: 10,
  sprints: [
    {
      endDate: "2026-07-18T19:10:00.000Z",
      goal: "Ship checkout",
      id: 5205,
      link: "https://example.atlassian.net/rest/agile/1.0/sprint/5205",
      name: "Sprint 12",
      startDate: "2026-07-07T16:34:59.388Z",
      state: "active",
    },
    {
      endDate: "2026-07-04T12:54:00.000Z",
      goal: "",
      id: 5206,
      link: "https://example.atlassian.net/rest/agile/1.0/sprint/5206",
      name: "Sprint 11",
      startDate: "2026-06-22T10:18:00.351Z",
      state: "closed",
    },
  ],
};

/** `acli jira board list-projects --id 1013 --json` — projects under `projects`. */
export const boardProjectsPayload = {
  isLast: true,
  maxResults: 30,
  startAt: 0,
  total: 1,
  projects: [
    {
      id: "21248",
      key: "TEAM",
      link: "https://example.atlassian.net/rest/api/2/project/21248",
      name: "Team Project",
      projectCategory: null,
      type: "software",
    },
  ],
};

/** `acli jira sprint view --id 5205 --json` — one flat active sprint (no completeDate). */
export const sprintViewPayload = {
  endDate: "2026-07-18T19:10:00.000Z",
  goal: "Ship checkout",
  id: 5205,
  name: "Sprint 12",
  originBoardId: 1013,
  startDate: "2026-07-07T16:34:59.388Z",
  state: "active",
};

/** The same sprint after `update --state closed`, for post-mutation re-fetch. */
export const sprintViewClosedPayload = {
  ...sprintViewPayload,
  completeDate: "2026-07-14T13:59:00.000Z",
  state: "closed",
};

/**
 * `acli jira sprint list-workitems --sprint 5205 --board 1013 --json` — the
 * envelope carries maxResults/startAt/total alongside `issues`. Unsupported
 * --fields values are silently DROPPED by acli (verified live: `--fields
 * key,updated` returns `"fields": {}`).
 */
export const sprintWorkitemsPayload = {
  maxResults: 30,
  startAt: 0,
  total: 12,
  issues: [
    {
      fields: {
        assignee: {
          accountId: "5b10a2844c20165700ede21g",
          accountType: "atlassian",
          active: true,
          displayName: "Jane Doe",
          emailAddress: "jane@acme.com",
          self: "https://example.atlassian.net/rest/api/2/user?accountId=5b10a2844c20165700ede21g",
          timeZone: "Europe/Amsterdam",
        },
        issuetype: {
          description: "Issue type for a user story.",
          hierarchyLevel: 0,
          id: "10001",
          name: "Story",
          self: "https://example.atlassian.net/rest/api/2/issuetype/10001",
          subtask: false,
        },
        priority: {
          id: "10000",
          name: "High",
          self: "https://example.atlassian.net/rest/api/2/priority/10000",
        },
        status: {
          id: "3",
          name: "In Progress",
          self: "https://example.atlassian.net/rest/api/2/status/3",
          statusCategory: {
            colorName: "yellow",
            id: 4,
            key: "indeterminate",
            name: "In Progress",
            self: "https://example.atlassian.net/rest/api/2/statuscategory/4",
          },
        },
        summary: "Fix login redirect loop",
      },
      key: "TEAM-1",
    },
    {
      fields: {
        assignee: null,
        issuetype: {
          id: "10002",
          name: "Task",
          self: "https://example.atlassian.net/rest/api/2/issuetype/10002",
          subtask: false,
        },
        priority: {
          id: "10001",
          name: "Medium",
          self: "https://example.atlassian.net/rest/api/2/priority/10001",
        },
        status: {
          id: "1",
          name: "To Do",
          self: "https://example.atlassian.net/rest/api/2/status/1",
          statusCategory: {
            colorName: "blue-gray",
            id: 2,
            key: "new",
            name: "To Do",
          },
        },
        summary: "Add audit log export",
      },
      key: "TEAM-2",
    },
  ],
};

/** `acli jira sprint create ... --json` — HAND-AUTHORED (agile REST POST /sprint). */
export const sprintCreatePayload = {
  goal: "Prepare release",
  id: 5300,
  name: "Sprint 13",
  originBoardId: 1013,
  self: "https://example.atlassian.net/rest/agile/1.0/sprint/5300",
  state: "future",
};

/** The created sprint as `sprint view --id 5300 --json` returns it. */
export const sprintViewCreatedPayload = {
  goal: "Prepare release",
  id: 5300,
  name: "Sprint 13",
  originBoardId: 1013,
  state: "future",
};

/** `acli jira filter list --my --json` — values envelope (entry shape from view contract). */
export const filterListPayload = {
  values: [
    {
      description: "",
      favourite: true,
      id: "33312",
      jql: "project = TEAM AND status = Open ORDER BY Rank ASC",
      name: "My Open Bugs",
      owner: { displayName: "Jane Doe" },
    },
  ],
};

/** `acli jira filter search --json` — bare array; no jql/favourite in this shape. */
export const filterSearchPayload = [
  {
    id: "33312",
    name: "My Open Bugs",
    description: "",
    owner: {
      accountId: "5b10a2844c20165700ede21g",
      active: true,
      displayName: "Jane Doe",
      self: "https://example.atlassian.net/rest/api/3/user?accountId=5b10a2844c20165700ede21g",
    },
  },
  {
    id: "29941",
    name: "Team Backlog",
    description: "Backlog triage",
    owner: {
      accountId: "5c00aa11bb22cc33dd44ee55",
      active: true,
      displayName: "John Smith",
      self: "https://example.atlassian.net/rest/api/3/user?accountId=5c00aa11bb22cc33dd44ee55",
    },
  },
];

/** `acli jira filter view --id 33312 --json` — one flat filter with jql. */
export const filterViewPayload = {
  description: "",
  favourite: false,
  favouritedCount: 1,
  id: "33312",
  jql: "project = TEAM AND status = Open ORDER BY Rank ASC",
  name: "My Open Bugs",
  owner: { displayName: "Jane Doe" },
};

/** The same filter after `update --jql ...`, for post-mutation re-fetch. */
export const filterViewUpdatedPayload = {
  ...filterViewPayload,
  jql: "project = TEAM AND resolution = EMPTY ORDER BY Rank ASC",
};

/** `acli jira dashboard search --json` — bare array, same shape as filter search. */
export const dashboardSearchPayload = [
  {
    id: "12805",
    name: "Team Dashboard",
    description: "",
    owner: {
      accountId: "5b10a2844c20165700ede21g",
      active: true,
      displayName: "Jane Doe",
      self: "https://example.atlassian.net/rest/api/3/user?accountId=5b10a2844c20165700ede21g",
    },
  },
  {
    id: "12745",
    name: "Release Overview",
    description: "",
    owner: {
      accountId: "5c00aa11bb22cc33dd44ee55",
      active: false,
      displayName: "John Smith",
      self: "https://example.atlassian.net/rest/api/3/user?accountId=5c00aa11bb22cc33dd44ee55",
    },
  },
];

/** `acli jira field create ... --json` — HAND-AUTHORED (REST POST /rest/api/3/field). */
export const fieldCreatePayload = {
  id: "customfield_10500",
  key: "customfield_10500",
  name: "Customer Name",
  schema: {
    custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield",
    customId: 10500,
    type: "string",
  },
  searcherKey:
    "com.atlassian.jira.plugin.system.customfieldtypes:textsearcher",
  self: "https://example.atlassian.net/rest/api/3/field/customfield_10500",
};

// ---------------------------------------------------------------------------
// Work-item links
// ---------------------------------------------------------------------------

/**
 * Link fixtures.
 *
 * PROVENANCE: shapes captured LIVE from acli v1.3.30-stable on 2026-10-01
 * against a real authenticated Jira Cloud site using READ-ONLY calls, then
 * anonymized (keys, summaries, ids and hosts replaced; structure and field
 * sets preserved). Verified facts baked into these shapes:
 *  - `workitem link type --json` returns `{issueLinkTypes: [{name}]}` - type
 *    NAMES only, no inward/outward phrases.
 *  - `workitem view KEY --fields key,issuelinks --json` returns the REST issue
 *    shape; each `fields.issuelinks[]` entry is `{id, self, type: {id, name,
 *    inward, outward, self}}` plus exactly ONE of `outwardIssue`/`inwardIssue`
 *    (the other end), itself `{id, key, self, fields: {summary, status,
 *    priority, issuetype}}`. An item without links returns `issuelinks: []`.
 *    An entry with `outwardIssue: B` on item A reads "A <outward phrase> B";
 *    with `inwardIssue: B`, "A <inward phrase> B".
 *  - `workitem search --fields` REJECTS `issuelinks` ("field 'issuelinks' is
 *    not allowed"), and `--fields key` alone returns `[null]`.
 *  - `workitem link list --key KEY --json` (NOT used by the CLI) returns
 *    `{issueLinks: [{id, outwardIssueKey, typeName}]}` with
 *    `outwardIssueKey: null` whenever the listed item is the outward end.
 *  - `workitem link create` has no --json; on success it prints
 *    `✓ Link between issues has been successfully created (<out> <Type> <in>)`.
 *    Its direction was observed on a link created earlier by hand:
 *    `--out A --in B` left A's issuelinks with `inwardIssue: B` (and B's with
 *    `outwardIssue: A`), i.e. the flags map verbatim onto the REST link.
 *
 * NOT captured (no link was created or deleted on the live site for this
 * work): `link delete` output and any `link create`/`link delete` FAILURE
 * output. The CLI parses neither - it re-reads the item's links instead.
 */
export const linkTypePayload = {
  issueLinkTypes: [
    { name: "Blocks" },
    { name: "Cloners" },
    { name: "Duplicate" },
    { name: "Problem/Incident" },
    { name: "Relates" },
  ],
};

/** REST link-type objects as they appear inside an `issuelinks[]` entry. */
export const LINK_TYPE_OBJECTS: Record<
  string,
  { id: string; name: string; inward: string; outward: string; self: string }
> = {
  Blocks: {
    id: "10000",
    inward: "is blocked by",
    name: "Blocks",
    outward: "blocks",
    self: "https://example.atlassian.net/rest/api/3/issueLinkType/10000",
  },
  Cloners: {
    id: "10001",
    inward: "is cloned by",
    name: "Cloners",
    outward: "clones",
    self: "https://example.atlassian.net/rest/api/3/issueLinkType/10001",
  },
  Duplicate: {
    id: "10002",
    inward: "is duplicated by",
    name: "Duplicate",
    outward: "duplicates",
    self: "https://example.atlassian.net/rest/api/3/issueLinkType/10002",
  },
  "Problem/Incident": {
    id: "10004",
    inward: "is caused by",
    name: "Problem/Incident",
    outward: "causes",
    self: "https://example.atlassian.net/rest/api/3/issueLinkType/10004",
  },
  Relates: {
    id: "10003",
    inward: "relates to",
    name: "Relates",
    outward: "relates to",
    self: "https://example.atlassian.net/rest/api/3/issueLinkType/10003",
  },
};

/** The other end of a link, as nested inside an `issuelinks[]` entry. */
export function linkedIssue(key: string, summary: string, status: string) {
  return {
    fields: {
      issuetype: { id: "10002", name: "Task", subtask: false },
      priority: { id: "10001", name: "Medium" },
      status: { id: "1", name: status },
      summary,
    },
    id: `9${key.replace(/\D/g, "")}`,
    key,
    self: `https://example.atlassian.net/rest/api/3/issue/9${key.replace(/\D/g, "")}`,
  };
}

/**
 * `acli jira workitem view TEAM-1 --fields key,issuelinks --json`: TEAM-1
 * blocks TEAM-2, is blocked by OPS-9, and relates to OPS-3.
 */
export const linksViewPayload = {
  expand:
    "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations",
  fields: {
    issuelinks: [
      {
        id: "10042",
        outwardIssue: linkedIssue("TEAM-2", "Add audit log export", "To Do"),
        self: "https://example.atlassian.net/rest/api/3/issueLink/10042",
        type: LINK_TYPE_OBJECTS.Blocks,
      },
      {
        id: "10043",
        inwardIssue: linkedIssue("OPS-9", "Rotate signing keys", "In Progress"),
        self: "https://example.atlassian.net/rest/api/3/issueLink/10043",
        type: LINK_TYPE_OBJECTS.Blocks,
      },
      {
        id: "10044",
        inwardIssue: linkedIssue("OPS-3", "SSO outage, 12 July", "Done"),
        self: "https://example.atlassian.net/rest/api/3/issueLink/10044",
        type: LINK_TYPE_OBJECTS.Relates,
      },
    ],
  },
  id: "10001",
  key: "TEAM-1",
  self: "https://example.atlassian.net/rest/api/3/issue/10001",
};

/** `viewPayload` (the full detail set) for the same linked TEAM-1. */
export const viewLinkedPayload = {
  ...viewPayload,
  fields: {
    ...viewPayload.fields,
    issuelinks: linksViewPayload.fields.issuelinks,
  },
};
