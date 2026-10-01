import { Router, type Request } from "express";
import { TicketCategory, TicketStatus } from "../generated/prisma/enums.ts";
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

// --- input validation -------------------------------------------------------
// The same shape as `routes/users.ts`: a `Record` keyed by the union for each
// enum so adding a member is a compile error until it is accepted here, and
// `parseIntParam` for the paging numbers.

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function parseListQuery(query: Request["query"]): tickets.ListTicketsOptions {
  return {
    status: query.status === undefined ? undefined : parseStatusOrThrow(query.status),
    category: query.category === undefined ? undefined : parseCategoryOrThrow(query.category),
    sort: query.sort === undefined ? "newest" : parseSortOrThrow(query.sort),
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

/**
 * The categories, plus `none` for the unclassified - which is every ticket
 * until the Phase 5 classifier exists, so the filter is useless without it.
 */
const CATEGORY_FILTERS: Record<tickets.CategoryFilter, true> = {
  [TicketCategory.GENERAL_QUESTION]: true,
  [TicketCategory.TECHNICAL_QUESTION]: true,
  [TicketCategory.REFUND_REQUEST]: true,
  none: true,
};

function isCategoryFilter(value: unknown): value is tickets.CategoryFilter {
  return typeof value === "string" && Object.hasOwn(CATEGORY_FILTERS, value);
}

function parseCategoryOrThrow(value: unknown): tickets.CategoryFilter {
  if (isCategoryFilter(value)) return value;
  throw new HttpError(400, `category must be ${Object.keys(CATEGORY_FILTERS).join(", ")}`);
}

const SORTS: Record<tickets.TicketSort, true> = { newest: true, oldest: true };

function isTicketSort(value: unknown): value is tickets.TicketSort {
  return typeof value === "string" && Object.hasOwn(SORTS, value);
}

function parseSortOrThrow(value: unknown): tickets.TicketSort {
  if (isTicketSort(value)) return value;
  throw new HttpError(400, `sort must be ${Object.keys(SORTS).join(" or ")}`);
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
