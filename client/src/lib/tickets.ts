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

export type TicketSort = 'newest' | 'oldest'

export function isTicketSort(value: unknown): value is TicketSort {
  return value === 'newest' || value === 'oldest'
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

export type TicketListParams = {
  status?: TicketStatus
  category?: CategoryFilter
  sort?: TicketSort
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
}

export function ticketListQueryOptions(params: TicketListParams) {
  return queryOptions({
    queryKey: ticketKeys.list(params),
    queryFn: ({ signal }) => listTickets(params, signal),
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
