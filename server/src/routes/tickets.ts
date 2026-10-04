import { ticketReplySchema } from "@helpdesk/core/schemas/tickets";
import { Router, type Request } from "express";
import { TicketCategory, TicketStatus } from "../generated/prisma/enums.ts";
import { parseBody } from "../lib/validate.ts";
import { requireAuth } from "../middleware/require-auth.ts";
import { HttpError } from "../middleware/error-handler.ts";
import * as tickets from "../services/tickets.ts";

export const ticketsRouter: Router = Router();

// `requireAuth` only, deliberately no `requireRole`: working tickets is the
// agent's job, not an admin privilege (project-scope.md). Ticket ids are
// sequential integers and therefore guessable, which is fine precisely because
// every signed-in user may read every ticket.
ticketsRouter.use(requireAuth);

ticketsRouter.get("/", async (req, res) => {
  const query = parseListQuery(req.query);
  const { tickets: list, total } = await tickets.listTickets(query);
  res.json({ tickets: list, total, page: query.page, pageSize: query.pageSize });
});

ticketsRouter.get("/:id", async (req, res) => {
  res.json({ ticket: await tickets.getTicket(parseTicketId(req.params.id)) });
});

/**
 * Change a ticket's assignee, status or category. A partial update: the keys
 * present are the instruction and anything absent is left alone. Returns the
 * whole ticket, the same shape `GET /:id` does, so the client replaces what it
 * is holding rather than patching its copy and hoping the two agree.
 */
ticketsRouter.patch("/:id", async (req, res) => {
  const id = parseTicketId(req.params.id);
  const patch = parseTicketPatch(req.body ?? {});

  res.json({ ticket: await tickets.updateTicket(id, patch) });
});

/**
 * Add an agent's reply to a ticket. The body is `{ body }`, validated by
 * `ticketReplySchema` from `@helpdesk/core` - the same schema the composer
 * runs, so this 400 carries the message the form would have shown.
 *
 * Who the reply is from comes from the session, never the body: `req.user` is
 * in place because `requireAuth` ran above, and taking a name off the wire
 * would let any signed-in agent write in a colleague's name.
 *
 * 201 with the whole ticket in the detail shape. The reply changes three things
 * the client is holding - the thread, the message count and `lastMessageAt` -
 * so it replaces its copy rather than splicing one message into it, exactly as
 * it does with a PATCH.
 *
 * Stored only: nothing is emailed to the requester until the outbound sender
 * exists (tasks 4.12-4.15).
 */
ticketsRouter.post("/:id/messages", async (req, res) => {
  const id = parseTicketId(req.params.id);
  const { body } = parseBody(ticketReplySchema, req.body ?? {});
  const author = req.user!;

  res.status(201).json({ ticket: await tickets.addReply(id, author, body) });
});

// --- input validation -------------------------------------------------------
// The same shape as `routes/users.ts`: a `Record` keyed by the union for each
// enum so adding a member is a compile error until it is accepted here, and
// `parseIntParam` for the paging numbers.

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** What the list falls back to, which is also what the table shows as sorted. */
const DEFAULT_SORT_BY: tickets.TicketSortBy = "lastMessageAt";
const DEFAULT_SORT_DIR: tickets.SortDir = "desc";

function parseListQuery(query: Request["query"]): tickets.ListTicketsOptions {
  return {
    status: query.status === undefined ? undefined : parseStatusOrThrow(query.status),
    category: query.category === undefined ? undefined : parseCategoryOrThrow(query.category),
    // Defaulted independently, so `?sortDir=asc` on its own is meaningful -
    // consistent with `status` and `category` being independent of each other.
    sortBy: query.sortBy === undefined ? DEFAULT_SORT_BY : parseSortByOrThrow(query.sortBy),
    sortDir: query.sortDir === undefined ? DEFAULT_SORT_DIR : parseSortDirOrThrow(query.sortDir),
    page: parseIntParam(query.page, "page", 1),
    pageSize: parseIntParam(query.pageSize, "pageSize", DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  };
}

/**
 * Every `TicketStatus`, keyed by itself so the compiler demands an entry when a
 * fourth status is added - a `satisfies TicketStatus[]` array would only check
 * that each member is a status, not that none is missing. The keys are the enum
 * members rather than string literals, which is the rule for every enum in this
 * codebase (see CLAUDE.md on `Role`).
 */
const STATUSES: Record<TicketStatus, true> = {
  [TicketStatus.OPEN]: true,
  [TicketStatus.RESOLVED]: true,
  [TicketStatus.CLOSED]: true,
};

function isTicketStatus(value: unknown): value is TicketStatus {
  return typeof value === "string" && Object.hasOwn(STATUSES, value);
}

function parseStatusOrThrow(value: unknown): TicketStatus {
  if (isTicketStatus(value)) return value;
  throw new HttpError(400, `status must be ${Object.keys(STATUSES).join(", ")}`);
}

/** Every `TicketCategory`, keyed by itself for the reason `STATUSES` is. */
const CATEGORIES: Record<TicketCategory, true> = {
  [TicketCategory.GENERAL_QUESTION]: true,
  [TicketCategory.TECHNICAL_QUESTION]: true,
  [TicketCategory.REFUND_REQUEST]: true,
};

function isTicketCategory(value: unknown): value is TicketCategory {
  return typeof value === "string" && Object.hasOwn(CATEGORIES, value);
}

/**
 * The categories, plus `none` for the unclassified - which is every ticket
 * until the Phase 5 classifier exists, so the filter is useless without it.
 * Built from `CATEGORIES` rather than listed again, so the filter vocabulary
 * cannot drift from the enum it extends. `none` is a query-string device only:
 * a body says `null`.
 */
const CATEGORY_FILTERS: Record<tickets.CategoryFilter, true> = {
  ...CATEGORIES,
  none: true,
};

function isCategoryFilter(value: unknown): value is tickets.CategoryFilter {
  return typeof value === "string" && Object.hasOwn(CATEGORY_FILTERS, value);
}

function parseCategoryOrThrow(value: unknown): tickets.CategoryFilter {
  if (isCategoryFilter(value)) return value;
  throw new HttpError(400, `category must be ${Object.keys(CATEGORY_FILTERS).join(", ")}`);
}

/**
 * The sortable columns, keyed by the union so adding one to `TicketSortBy` is
 * a compile error until it is accepted here. The key order is also the order
 * the 400 message lists them in, so the message cannot drift from the set.
 */
const SORT_BYS: Record<tickets.TicketSortBy, true> = {
  subject: true,
  requesterName: true,
  status: true,
  category: true,
  messageCount: true,
  lastMessageAt: true,
};

function isTicketSortBy(value: unknown): value is tickets.TicketSortBy {
  return typeof value === "string" && Object.hasOwn(SORT_BYS, value);
}

function parseSortByOrThrow(value: unknown): tickets.TicketSortBy {
  if (isTicketSortBy(value)) return value;
  throw new HttpError(400, `sortBy must be ${Object.keys(SORT_BYS).join(", ")}`);
}

const SORT_DIRS: Record<tickets.SortDir, true> = { asc: true, desc: true };

function isSortDir(value: unknown): value is tickets.SortDir {
  return typeof value === "string" && Object.hasOwn(SORT_DIRS, value);
}

function parseSortDirOrThrow(value: unknown): tickets.SortDir {
  if (isSortDir(value)) return value;
  throw new HttpError(400, `sortDir must be ${Object.keys(SORT_DIRS).join(" or ")}`);
}

/**
 * A PATCH body, read one key at a time. Presence is the instruction: a key
 * that is there is a change, a key that is absent leaves that field alone -
 * which is why `null` on the two nullable fields is a value rather than a way
 * of saying nothing, and why `Object.hasOwn` rather than `!== undefined` is
 * what decides. An explicit `{ "status": undefined }` cannot survive JSON
 * anyway, but the distinction is the API's to keep.
 *
 * An empty patch is refused rather than quietly returning the ticket
 * unchanged: a request that asks for nothing is a client bug, and a 200 would
 * hide it.
 */
function parseTicketPatch(body: Record<string, unknown>): tickets.TicketPatch {
  const patch: tickets.TicketPatch = {};

  if (Object.hasOwn(body, "assignedToId")) {
    patch.assignedToId = parseAssigneeOrThrow(body.assignedToId);
  }
  if (Object.hasOwn(body, "status")) {
    patch.status = parseStatusOrThrow(body.status);
  }
  if (Object.hasOwn(body, "category")) {
    patch.category = parseCategoryValueOrThrow(body.category);
  }

  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, "Supply at least one of assignedToId, status or category");
  }
  return patch;
}

/**
 * A category from a PATCH body: one of the enum, or `null` to clear the
 * classification. Not `none` - that is the list filter's spelling, and a JSON
 * body has a real null to use.
 */
function parseCategoryValueOrThrow(value: unknown): TicketCategory | null {
  if (value === null || isTicketCategory(value)) return value;
  throw new HttpError(400, `category must be ${Object.keys(CATEGORIES).join(", ")} or null`);
}

/**
 * The assignee from a PATCH body: a user id, or `null` to unassign.
 *
 * Whether that id names someone who can hold a ticket is the service's
 * question; this only decides whether the body is the right shape.
 */
function parseAssigneeOrThrow(value: unknown): string | null {
  if (value === null) return null;
  // No trimming: an id is matched exactly, so a value needing a trim is not
  // one of ours. An empty string means the client sent a blank select rather
  // than the unassign it meant, which is worth saying out loud.
  if (typeof value === "string" && value.length > 0) return value;
  throw new HttpError(400, "assignedToId must be a user id or null");
}

/**
 * A ticket id from the path. Anything that is not a positive integer is a 404
 * rather than a 400: `/api/tickets/abc` names no ticket, and "Ticket not
 * found" is both true and the one message the detail page has to render. A
 * query parameter is different - there the field name is worth saying, which
 * is what `parseIntParam` below does.
 */
function parseTicketId(value: string): number {
  if (!/^\d+$/.test(value)) throw new HttpError(404, "Ticket not found");
  const id = Number(value);
  // Beyond 2^31 Postgres would reject the comparison against an `int4` column
  // outright, so it is refused here as the miss it is.
  if (!Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647) {
    throw new HttpError(404, "Ticket not found");
  }
  return id;
}

/**
 * Digits only: `Number()` would accept `1e2`, ` 7` and `0x10`. The same helper
 * as `routes/users.ts` - kept local rather than shared, because the two will
 * diverge the moment either endpoint needs a different limit, and a shared
 * query parser is a worse coupling than a duplicated ten lines.
 */
function parseIntParam(value: unknown, field: string, fallback: number, max?: number): number {
  if (value === undefined) return fallback;

  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || (max !== undefined && parsed > max)) {
    throw new HttpError(
      400,
      max === undefined
        ? `${field} must be a positive integer`
        : `${field} must be an integer between 1 and ${max}`,
    );
  }
  return parsed;
}
