import { Prisma } from "../generated/prisma/client.ts";
import type { TicketCategory, TicketStatus } from "../generated/prisma/enums.ts";
import { prisma } from "../lib/prisma.ts";

/**
 * The ticket shape the list endpoint returns.
 *
 * Three columns are deliberately absent. `bodyHtml` is sender-supplied markup
 * and the client has no sanitiser, so it does not cross the wire until
 * something is ready to render it safely; `body` and `assignedToId` are simply
 * not on the list view yet, and a field in the response that nothing reads is
 * a field that quietly becomes part of the contract. The detail endpoint (task
 * 3.6) is where all three belong.
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

/** Newest or oldest activity first. The list's one ordering control. */
export type TicketSort = "newest" | "oldest";

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
  sort: TicketSort;
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

  const direction = options.sort === "oldest" ? "asc" : "desc";

  const [tickets, total] = await prisma.$transaction([
    prisma.ticket.findMany({
      where,
      select: publicTicketSelect,
      // Activity order, which is what an agent working a queue wants. `id`
      // breaks ties so a row cannot appear on two pages - two emails arriving
      // in the same millisecond is unlikely but a mail burst is exactly when
      // it would happen.
      orderBy: [{ lastMessageAt: direction }, { id: "asc" }],
      skip: (options.page - 1) * options.pageSize,
      take: options.pageSize,
    }),
    prisma.ticket.count({ where }),
  ]);

  return { tickets: tickets.map(toPublicTicket), total };
}
