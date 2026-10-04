/**
 * The tickets API (`/api/tickets`). Transport stays in `api.ts`; this file knows
 * the endpoint's parameters and response shape.
 *
 * The two ticket enums live here rather than in `api.ts`. `Role` sits in
 * `api.ts` because it is a field of `PublicUser`, which is declared there; these
 * are fields of `Ticket`, which is declared here, and the nearer precedent is
 * `UserStatus` in `lib/users.ts`. Each enum mirror lives beside the type that
 * uses it.
 */
import { queryOptions } from '@tanstack/react-query'
import { apiFetch } from './api.ts'
import type { SortDir } from './sorting.ts'

/**
 * Mirrors `enum TicketStatus` in `server/prisma/schema.prisma`. A const object
 * rather than a TypeScript `enum`: the client tsconfig sets `erasableSyntaxOnly`,
 * which forbids the keyword, and Prisma 7 generates this same shape so the two
 * stay comparable. Use `TicketStatus.OPEN`, never the string.
 */
export const TicketStatus = {
  OPEN: 'OPEN',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED',
} as const

export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus]

export function isTicketStatus(value: unknown): value is TicketStatus {
  return typeof value === 'string' && Object.values<string>(TicketStatus).includes(value)
}

/** Mirrors `enum TicketCategory`. Null on a ticket means not yet classified. */
export const TicketCategory = {
  GENERAL_QUESTION: 'GENERAL_QUESTION',
  TECHNICAL_QUESTION: 'TECHNICAL_QUESTION',
  REFUND_REQUEST: 'REFUND_REQUEST',
} as const

export type TicketCategory = (typeof TicketCategory)[keyof typeof TicketCategory]

export function isTicketCategory(value: unknown): value is TicketCategory {
  return typeof value === 'string' && Object.values<string>(TicketCategory).includes(value)
}

/**
 * What the Category filter can ask for. `'none'` is the unclassified, which the
 * server accepts as a distinct value: until the Phase 5 classifier runs every
 * ticket has `category: null`, so a filter without it would match nothing.
 */
export type CategoryFilter = TicketCategory | 'none'

export function isCategoryFilter(value: unknown): value is CategoryFilter {
  return value === 'none' || isTicketCategory(value)
}

/**
 * The columns `GET /api/tickets` can order by. Mirrors `TicketSortBy` in
 * `server/src/services/tickets.ts`, and the members are exactly the column ids
 * `TicketsTable` gives TanStack Table - the header an agent clicks, the
 * parameter on the wire and the server's lookup key are one string, with no
 * translation table that could drift.
 *
 * A `Record` keyed by itself rather than an array, so adding a member is a
 * compile error until it has an entry; the guard is what turns a TanStack
 * column id (typed as plain `string`) back into one of these.
 */
const TICKET_SORT_BYS = {
  subject: true,
  requesterName: true,
  status: true,
  category: true,
  messageCount: true,
  lastMessageAt: true,
} as const

export type TicketSortBy = keyof typeof TICKET_SORT_BYS

export function isTicketSortBy(value: unknown): value is TicketSortBy {
  return typeof value === 'string' && Object.hasOwn(TICKET_SORT_BYS, value)
}

/**
 * Mirrors `publicTicketSelect` in `server/src/services/tickets.ts`. Dates are
 * strings because they arrive as JSON, and `id` is a number because the server
 * gives tickets an auto-incrementing integer - agents read ticket numbers out
 * loud, so they are short.
 *
 * Note what is absent: `body`, `bodyHtml` and `assignedToId` are columns on the
 * ticket but not on this list response. `bodyHtml` especially - it is untrusted
 * sender markup, and nothing here sanitises it.
 */
export type Ticket = {
  id: number
  subject: string
  status: TicketStatus
  /** Null until a ticket has been classified. */
  category: TicketCategory | null
  requesterEmail: string
  requesterName: string
  /** When the newest message on the ticket arrived; the list's sort key. */
  lastMessageAt: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

/**
 * Mirrors `enum MessageDirection` in `server/prisma/schema.prisma`: INBOUND is
 * from the student, OUTBOUND from an agent. Same const-object shape and the
 * same reason as the two enums above.
 */
export const MessageDirection = {
  INBOUND: 'INBOUND',
  OUTBOUND: 'OUTBOUND',
} as const

export type MessageDirection = (typeof MessageDirection)[keyof typeof MessageDirection]

/**
 * One message on a ticket. Mirrors `PublicMessage` in
 * `server/src/services/tickets.ts`.
 *
 * `bodyHtml` is absent on purpose, as it is on the ticket: it is untrusted
 * sender markup and nothing here sanitises it. `body` is the same message as
 * plain text, already stripped of the quoted reply and the signature.
 */
export type TicketMessage = {
  id: number
  direction: MessageDirection
  fromEmail: string
  fromName: string
  body: string
  createdAt: string
}

/** The agent a ticket is assigned to. Null for the unassigned queue. */
export type TicketAssignee = {
  id: string
  name: string
  email: string
}

/**
 * What `GET /api/tickets/:id` returns: the list row plus the three things the
 * list has no use for. Mirrors `PublicTicketDetail` in
 * `server/src/services/tickets.ts`, and is deliberately `Ticket` *plus* fields
 * rather than a second ticket type, so anything that renders a list row
 * renders a detail too.
 */
export type TicketDetail = Ticket & {
  assignedTo: TicketAssignee | null
  /** Oldest first - a thread is read in the order it happened. */
  messages: TicketMessage[]
}

export type TicketListParams = {
  status?: TicketStatus
  category?: CategoryFilter
  /** Both keys or neither; absent means the server's default order. */
  sortBy?: TicketSortBy
  sortDir?: SortDir
  page?: number
  pageSize?: number
}

/** Mirrors the body of `GET /api/tickets` in `server/src/routes/tickets.ts`. */
export type TicketListResponse = {
  tickets: Ticket[]
  total: number
  page: number
  pageSize: number
}

/**
 * Query keys for everything under `/api/tickets`. `all` is what a write would
 * invalidate once anything mutates a ticket; the list key carries its params so
 * each page and filter combination is cached on its own.
 */
export const ticketKeys = {
  all: ['tickets'] as const,
  list: (params: TicketListParams) => [...ticketKeys.all, 'list', params] as const,
  detail: (id: number) => [...ticketKeys.all, 'detail', id] as const,
}

export function ticketListQueryOptions(params: TicketListParams) {
  return queryOptions({
    queryKey: ticketKeys.list(params),
    queryFn: ({ signal }) => listTickets(params, signal),
  })
}

export function ticketDetailQueryOptions(id: number) {
  return queryOptions({
    queryKey: ticketKeys.detail(id),
    queryFn: ({ signal }) => getTicket(id, signal),
  })
}

export function listTickets(
  params: TicketListParams,
  signal?: AbortSignal,
): Promise<TicketListResponse> {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  const query = search.toString()

  return apiFetch<TicketListResponse>(query ? `/api/tickets?${query}` : '/api/tickets', { signal })
}

/** One ticket and its thread. A 404 arrives as an `ApiError`, like any refusal. */
export async function getTicket(id: number, signal?: AbortSignal): Promise<TicketDetail> {
  const { ticket } = await apiFetch<{ ticket: TicketDetail }>(`/api/tickets/${id}`, { signal })
  return ticket
}
