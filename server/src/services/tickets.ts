import { Prisma } from "../generated/prisma/client.ts";
import type { TicketCategory, TicketStatus } from "../generated/prisma/enums.ts";
import { prisma } from "../lib/prisma.ts";
import { serializable } from "../lib/transaction.ts";
import { HttpError } from "../middleware/error-handler.ts";

/**
 * The ticket shape the list endpoint returns.
 *
 * Three columns are deliberately absent. `bodyHtml` is sender-supplied markup
 * and the client has no sanitiser, so it does not cross the wire until
 * something is ready to render it safely; `body` and `assignedToId` are simply
 * not on the list view yet, and a field in the response that nothing reads is
 * a field that quietly becomes part of the contract. `getTicket` below adds
 * the first two; `bodyHtml` still goes nowhere.
 */
const publicTicketSelect = {
  id: true,
  subject: true,
  status: true,
  category: true,
  requesterEmail: true,
  requesterName: true,
  lastMessageAt: true,
  createdAt: true,
  updatedAt: true,
  // How long the thread is, which the list shows as a count rather than
  // fetching the messages themselves.
  _count: { select: { messages: true } },
} as const satisfies Prisma.TicketSelect;

type TicketRow = Prisma.TicketGetPayload<{ select: typeof publicTicketSelect }>;

/**
 * What the API returns. Prisma's `_count` nesting is flattened to a plain
 * `messageCount`, so the client is not shaped by how the count happened to be
 * fetched - the one place this type and the Prisma row differ.
 */
export type PublicTicket = Omit<TicketRow, "_count"> & { messageCount: number };

function toPublicTicket({ _count, ...ticket }: TicketRow): PublicTicket {
  return { ...ticket, messageCount: _count.messages };
}

/**
 * The columns the list can be ordered by. The members are exactly the column
 * ids the client's table uses, so the header the agent clicks, the parameter on
 * the wire and the key into `ORDER_BY` below are one string with no translation
 * table between them. Mirrored in `client/src/lib/tickets.ts` - a duplicated
 * vocabulary with a guard, the same arrangement `TicketStatus` already has,
 * because `core/` is for Zod schemas a form fills and may not import Prisma.
 */
export type TicketSortBy =
  | "subject"
  | "requesterName"
  | "status"
  | "category"
  | "messageCount"
  | "lastMessageAt";

/**
 * Declared here rather than shared with the users service: it coincides with
 * `Prisma.SortOrder`, and spelling it out keeps the wire vocabulary ours rather
 * than whatever Prisma happens to call its own.
 */
export type SortDir = "asc" | "desc";

/**
 * One `orderBy` fragment per sortable column, keyed by the union so adding a
 * column is a compile error until it has an ordering. A `Record` rather than a
 * ternary: the ternary this replaced treated every unrecognised value as
 * `desc`, which is exactly the silence a lookup cannot produce.
 *
 * Two things worth knowing about what Postgres does with these. Enum columns
 * sort by the Prisma schema's *declaration* order, so `status` runs
 * OPEN < RESOLVED < CLOSED (lifecycle order, which is what an agent wants) while
 * `category` runs General < Technical < Refund, whose labels read in a different
 * order. And `category` is nullable, so the unclassified sink to the bottom on
 * `asc` and rise to the top on `desc`.
 */
const ORDER_BY: Record<TicketSortBy, (dir: SortDir) => Prisma.TicketOrderByWithRelationInput[]> = {
  subject: (dir) => [{ subject: dir }],
  // The address is the secondary term because `requesterName` falls back to the
  // local part of the address when `From` carries no display name, so duplicate
  // names are routine rather than exceptional.
  requesterName: (dir) => [{ requesterName: dir }, { requesterEmail: dir }],
  // With three distinct values, "sort by status" is really "group by status",
  // and without a second term the rows inside a group fall back to `id asc` -
  // oldest first, the opposite of queue order. The cost is that `desc` is not
  // then the strict inverse of `asc`: the grouping flips, the order within a
  // group does not. The direction control is about the column that was clicked.
  status: (dir) => [{ status: dir }, { lastMessageAt: "desc" }],
  category: (dir) => [{ category: dir }, { lastMessageAt: "desc" }],
  // Not a column: the `_count` aggregate. A LEFT JOIN + GROUP BY + ORDER BY
  // count(*) - the one query whose shape changes with the sort key, and the one
  // no index can help.
  messageCount: (dir) => [{ messages: { _count: dir } }],
  lastMessageAt: (dir) => [{ lastMessageAt: dir }],
};

function orderByFor(sortBy: TicketSortBy, sortDir: SortDir) {
  // The unique tiebreaker is appended in one place rather than repeated six
  // times, so no key can be added without it and no row can straddle a page -
  // two emails arriving in the same millisecond is unlikely, but a mail burst
  // is exactly when it would happen.
  return [...ORDER_BY[sortBy](sortDir), { id: "asc" as const }];
}

/**
 * `"none"` selects the unclassified. A separate value rather than an absent
 * `category`, which already means "any": until the Phase 5 classifier runs
 * every ticket has `category: null`, so "show me the ones with no category" is
 * a question the filter has to be able to ask.
 */
export type CategoryFilter = TicketCategory | "none";

export type ListTicketsOptions = {
  status?: TicketStatus;
  category?: CategoryFilter;
  /**
   * Non-optional, the treatment `sort` had before it: the route defaults both
   * independently, which is what keeps the `ORDER_BY` lookup provably total.
   * (`services/users.ts` defaults in the service instead, because its default
   * is a composite no single column names - see `DEFAULT_ORDER_BY` there.)
   */
  sortBy: TicketSortBy;
  sortDir: SortDir;
  /** 1-based. */
  page: number;
  pageSize: number;
};

/**
 * One page of tickets plus the total matching the same filters. A page past the
 * end returns no tickets with the real total; the caller decides where to go.
 */
export async function listTickets(
  options: ListTicketsOptions,
): Promise<{ tickets: PublicTicket[]; total: number }> {
  const where: Prisma.TicketWhereInput = {
    ...(options.status !== undefined && { status: options.status }),
    ...(options.category !== undefined && {
      category: options.category === "none" ? null : options.category,
    }),
  };

  const [tickets, total] = await prisma.$transaction([
    prisma.ticket.findMany({
      where,
      select: publicTicketSelect,
      // The whole result set is ordered here, not the visible page, so paging
      // stays correct under any sort. With no parameters this is
      // `[{ lastMessageAt: "desc" }, { id: "asc" }]` - activity order, which is
      // what an agent working a queue wants.
      orderBy: orderByFor(options.sortBy, options.sortDir),
      skip: (options.page - 1) * options.pageSize,
      take: options.pageSize,
    }),
    prisma.ticket.count({ where }),
  ]);

  return { tickets: tickets.map(toPublicTicket), total };
}

/**
 * One ticket with its thread, for the detail page.
 *
 * It is the list row plus the two things the list has no use for: who the
 * ticket is assigned to, and the messages themselves. `messageCount` is kept
 * even though `messages.length` would give it, so the detail shape is the list
 * shape plus fields rather than a second, incompatible ticket type on the
 * client.
 *
 * Two columns stay behind. `Ticket.body` is the first message denormalised, so
 * the thread below already carries it - and the list's rule holds here too:
 * a field the page does not read is a field that quietly becomes part of the
 * contract. `bodyHtml`, on the ticket and on every message, is untrusted
 * sender markup, and this is the endpoint that was always going to be tempted
 * to include it; nothing on the client sanitises it, so until something does,
 * the HTML part of an email does not leave the server. The plain-text `body`
 * on each message is the same mail with the quoted reply and signature
 * stripped, which is what an agent reads anyway.
 */
const messageSelect = {
  id: true,
  direction: true,
  fromEmail: true,
  fromName: true,
  body: true,
  createdAt: true,
} as const satisfies Prisma.MessageSelect;

const ticketDetailSelect = {
  ...publicTicketSelect,
  // The agent's name is what the page shows; the id is what a future assign
  // control would write back.
  assignedTo: { select: { id: true, name: true, email: true } },
  messages: {
    select: messageSelect,
    // Oldest first: a thread is read in the order it happened, which is the
    // opposite of the queue's ordering. `id` breaks a tie the way the list's
    // `orderByFor` does - two messages can share a timestamp.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
} as const satisfies Prisma.TicketSelect;

type TicketDetailRow = Prisma.TicketGetPayload<{ select: typeof ticketDetailSelect }>;

export type PublicMessage = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

export type PublicTicketDetail = Omit<TicketDetailRow, "_count"> & { messageCount: number };

/**
 * A ticket by id, or a 404. No ownership check: `GET /api/tickets` is
 * `requireAuth` only for the same reason - every signed-in user may read every
 * ticket, which is what makes a guessable sequential id harmless.
 */
export async function getTicket(id: number): Promise<PublicTicketDetail> {
  const ticket = await prisma.ticket.findUnique({ where: { id }, select: ticketDetailSelect });
  if (!ticket) throw new HttpError(404, "Ticket not found");

  return toPublicTicketDetail(ticket);
}

function toPublicTicketDetail({ _count, ...ticket }: TicketDetailRow): PublicTicketDetail {
  return { ...ticket, messageCount: _count.messages };
}

/**
 * Give a ticket to someone, or take it back off them with `null`.
 *
 * Any signed-in user may do this to any ticket, including one already held by
 * somebody else: the same reasoning as the queue being readable by everyone -
 * a helpdesk hands work around, and a ticket nobody can take off a colleague
 * who is away is a ticket nobody answers. The acting user is not recorded;
 * there is no audit trail on tickets yet.
 *
 * The check and the write share a serializable transaction, as every other
 * check-then-write in this codebase does: without it an account deactivated
 * between the two would still end up holding a ticket, and `active` is the one
 * gate everything else trusts.
 */
export async function assignTicket(
  id: number,
  assignedToId: string | null,
): Promise<PublicTicketDetail> {
  const ticket = await serializable(async (tx) => {
    if (assignedToId !== null) {
      const assignee = await tx.user.findUnique({
        where: { id: assignedToId },
        select: { active: true },
      });

      // A 400 rather than a 404: the ticket in the path exists, and it is the
      // body that names someone who cannot have it. The messages are
      // user-facing sentences, like the shared schemas' - the client shows
      // them as they arrive.
      if (!assignee) throw new HttpError(400, "That user no longer exists.");
      if (!assignee.active) {
        throw new HttpError(400, "A deactivated user cannot be assigned tickets.");
      }
    }

    const exists = await tx.ticket.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new HttpError(404, "Ticket not found");

    return tx.ticket.update({
      where: { id },
      data: { assignedToId },
      select: ticketDetailSelect,
    });
  });

  return toPublicTicketDetail(ticket);
}
