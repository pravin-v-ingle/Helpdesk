/**
 * Reading the ticket queue - through `GET /api/tickets` for the facts a spec
 * needs to set up or confirm, and through the table on `/tickets` for what an
 * agent actually sees.
 */
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * Mirrors `enum TicketStatus` in `server/prisma/schema.prisma` (and the const in
 * `client/src/lib/tickets.ts`). A const object, not a TypeScript `enum`: this
 * workspace sets `erasableSyntaxOnly`, which forbids the keyword.
 */
export const TicketStatus = {
  OPEN: "OPEN",
  RESOLVED: "RESOLVED",
  CLOSED: "CLOSED",
} as const;

export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus];

/** Mirrors `enum TicketCategory`. Null on a ticket means not yet classified. */
export const TicketCategory = {
  GENERAL_QUESTION: "GENERAL_QUESTION",
  TECHNICAL_QUESTION: "TECHNICAL_QUESTION",
  REFUND_REQUEST: "REFUND_REQUEST",
} as const;

export type TicketCategory = (typeof TicketCategory)[keyof typeof TicketCategory];

/**
 * The columns `GET /api/tickets` can order by - mirrors `TicketSortBy` in
 * `server/src/services/tickets.ts` and the const in `client/src/lib/tickets.ts`.
 * A union rather than a loose string, because this is what stops the query
 * helper below accepting a parameter the API has never heard of: the retired
 * `?sort=newest|oldest` went on compiling for exactly that reason.
 */
export type TicketSortBy =
  | "subject"
  | "requesterName"
  | "status"
  | "category"
  | "messageCount"
  | "lastMessageAt";

export type SortDir = "asc" | "desc";

/** Mirrors `publicTicketSelect` in `server/src/services/tickets.ts`. */
export type Ticket = {
  id: number;
  subject: string;
  status: TicketStatus;
  category: TicketCategory | null;
  requesterEmail: string;
  requesterName: string;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type TicketListResponse = {
  tickets: Ticket[];
  total: number;
  page: number;
  pageSize: number;
};

/** The largest page `GET /api/tickets` allows. */
const MAX_PAGE_SIZE = 100;

/**
 * Every parameter `GET /api/tickets` accepts, each typed as the server types
 * it. A spec that wants to send something the API would refuse has to call
 * `request.get` itself - which is what the 400 tests do - so a typo in a
 * parameter name cannot quietly become an ignored key and a passing test.
 */
export type TicketListQuery = {
  status?: TicketStatus;
  category?: TicketCategory | "none";
  /** Both keys or neither; omitting them asks for the server's default order. */
  sortBy?: TicketSortBy;
  sortDir?: SortDir;
  page?: number;
  pageSize?: number;
};

/** One page of `GET /api/tickets`, asserting the request succeeded. */
export async function listTickets(
  request: APIRequestContext,
  query: TicketListQuery = {},
): Promise<TicketListResponse> {
  // Rebuilt into Playwright's index-signature shape, dropping the keys that
  // were left undefined: an absent parameter and an empty one are different
  // requests, and only the first means "whatever the server's default is".
  const params: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params[key] = value;
  }

  const res = await request.get("/api/tickets", { params });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as TicketListResponse;
}

/** How many tickets exist in total, filters aside. */
export async function ticketCount(request: APIRequestContext): Promise<number> {
  // `pageSize: 1` because only the total is wanted; the row is incidental.
  return (await listTickets(request, { pageSize: 1 })).total;
}

/**
 * The ticket with this subject, or undefined. Walks every page rather than
 * trusting the first: `GET /api/tickets` has no `?q=`, so a search is a scan,
 * and the suite's own tickets are not guaranteed to be on page one.
 */
export async function findTicketBySubject(
  request: APIRequestContext,
  subject: string,
): Promise<Ticket | undefined> {
  for (let page = 1; ; page++) {
    const body = await listTickets(request, { page, pageSize: MAX_PAGE_SIZE });
    const match = body.tickets.find((ticket) => ticket.subject === subject);
    if (match) return match;
    if (body.tickets.length < MAX_PAGE_SIZE || page * MAX_PAGE_SIZE >= body.total) {
      return undefined;
    }
  }
}

/** The tickets table on `/tickets`. Named, so the skeleton cannot match it. */
export function ticketsTable(page: Page): Locator {
  return page.getByRole("table", { name: "Tickets" });
}

/** The row for a ticket, found by the subject in its first cell. */
export function ticketRow(page: Page, subject: string): Locator {
  return ticketsTable(page)
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: subject, exact: true }) });
}

/**
 * Every body row's subject, in the order the table renders them. Scoped to
 * `tbody` so the header row is not one of them, and read through `ticketCells`
 * so it follows the same first-cell-is-the-subject rule as `ticketRow`.
 */
export async function ticketSubjectsInOrder(page: Page): Promise<string[]> {
  const rows = await ticketsTable(page).locator("tbody").getByRole("row").all();
  return Promise.all(
    rows.map(async (row) => ((await ticketCells(row).subject.textContent()) ?? "").trim()),
  );
}

/**
 * The cells of a ticket row, in the table's column order. `Messages` is read
 * as its own locator rather than by text, so a count of `1` cannot be satisfied
 * by a `1` elsewhere in the row.
 */
export function ticketCells(row: Locator) {
  const cells = row.getByRole("cell");
  return {
    subject: cells.nth(0),
    requester: cells.nth(1),
    status: cells.nth(2),
    category: cells.nth(3),
    messages: cells.nth(4),
    lastMessage: cells.nth(5),
  };
}

/**
 * A column header of the tickets table, by its label - the `<th>` itself, not
 * the button inside it. `aria-sort` is on the header cell (ARIA puts it there,
 * and `SortableHead.tsx` follows), so this is the locator a direction
 * assertion reads; to sort, click `sortHeader(page, "Subject").getByRole(
 * "button", { name: "Subject" })`. The exact name match is what keeps the
 * header's accessible name pinned to the bare column label: the direction
 * indicator is an `aria-hidden` icon, never a text glyph.
 */
export function sortHeader(page: Page, label: string): Locator {
  return ticketsTable(page).getByRole("columnheader", { name: label, exact: true });
}
