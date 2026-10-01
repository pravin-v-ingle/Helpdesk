import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Pagination } from '../components/Pagination.tsx'
import {
  TicketsTable,
  TicketsTableSkeleton,
  TICKET_CATEGORY_LABELS,
  TICKET_STATUS_LABELS,
} from '../components/TicketsTable.tsx'
import { ApiError } from '../lib/api.ts'
import {
  isCategoryFilter,
  isTicketStatus,
  ticketListQueryOptions,
  type CategoryFilter,
  type TicketListParams,
  type TicketListResponse,
} from '../lib/tickets.ts'

// The server's defaults and limits (server/src/routes/tickets.ts). The URL is
// normalised against them here so the client never sends a value it would
// refuse with a 400.
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

const NETWORK_ERROR = 'Could not reach the server. Please try again.'

type Filters = Required<Pick<TicketListParams, 'page' | 'pageSize'>> &
  Pick<TicketListParams, 'status' | 'category'>

/** Every filter key stored in the URL. `pageSize` is URL-only: no control sets it. */
type FilterPatch = Partial<Record<'status' | 'category' | 'page', string | undefined>>

/**
 * The Category select's options, in the order they are offered. `none` comes
 * first among the real values because, until the Phase 5 classifier exists,
 * every ticket is in it - a Category filter without an Uncategorised option
 * would be a control that can only ever return nothing.
 */
const CATEGORY_FILTER_LABELS: Record<CategoryFilter, string> = {
  none: 'Uncategorised',
  ...TICKET_CATEGORY_LABELS,
}

/**
 * The URL is the only source of filter state, so a reload or Back keeps the
 * view. Anything unusable is dropped silently rather than reported.
 */
function readFilters(params: URLSearchParams): Filters {
  const status = params.get('status')
  const category = params.get('category')

  return {
    status: isTicketStatus(status) ? status : undefined,
    category: isCategoryFilter(category) ? category : undefined,
    page: readPositiveInt(params.get('page')) ?? 1,
    pageSize: Math.min(readPositiveInt(params.get('pageSize')) ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  }
}

function readPositiveInt(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return parsed >= 1 ? parsed : undefined
}

function totalPagesOf({ total, pageSize }: TicketListResponse): number {
  return Math.max(1, Math.ceil(total / pageSize))
}

/**
 * The ticket queue: the list, filterable by status and category, and paginated.
 * The page owns the URL state and the query; `TicketsTable` renders the rows.
 *
 * Not admin-gated - working tickets is the agent's job - so this sits outside
 * the `RequireRole` branch of the route table.
 *
 * No search box: there is no `?q=` on `GET /api/tickets` yet, and no sort
 * control, though the endpoint accepts `?sort=` (task 3.9b).
 */
export function TicketsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  // `filters` is part of the query key. It is hashed structurally, so the new
  // object `setSearchParams` produces for an unchanged URL does not refetch.
  const filters = useMemo(() => readFilters(searchParams), [searchParams])

  // `keepPreviousData` shows the previous page's rows while the next page
  // loads, so the table does not collapse to a skeleton on every change. A
  // superseded request is cancelled through the query's `signal`.
  const query = useQuery({ ...ticketListQueryOptions(filters), placeholderData: keepPreviousData })
  const fetching = query.isFetching
  const error = query.error
    ? query.error instanceof ApiError
      ? query.error.message
      : NETWORK_ERROR
    : undefined

  // The last successful response. A failed request leaves `query.data`
  // undefined, and the table it replaced should stay on screen under the error
  // rather than flash back to the skeleton. Adjusted during render, the pattern
  // React documents for state derived from a changed prop.
  const [data, setData] = useState(query.data)
  if (query.data && query.data !== data) setData(query.data)

  const updateFilters = useCallback(
    (patch: FilterPatch, replace = false) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined || value === '') next.delete(key)
            else next.set(key, value)
          }
          // A changed filter restarts at page 1, and page 1 is stored as absent
          // so the plain `/tickets` URL and "page 1 of the same" are one entry.
          if ('status' in patch || 'category' in patch) next.delete('page')
          if (next.get('page') === '1') next.delete('page')
          return next
        },
        { replace },
      )
    },
    [setSearchParams],
  )

  // A page past the end (a stale link, or the last row on the last page just
  // moved) snaps to the real last page. Replaced, so Back does not return to it.
  useEffect(() => {
    if (!data) return
    const totalPages = totalPagesOf(data)
    if (data.tickets.length === 0 && data.total > 0 && data.page > totalPages) {
      updateFilters({ page: String(totalPages) }, true)
    }
  }, [data, updateFilters])

  const filtered = filters.status !== undefined || filters.category !== undefined

  return (
    <main className="flex-1 px-6 py-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Tickets</h1>
        {/* No "Add ticket" button: tickets arrive by email, never from the UI. */}
      </div>

      <div className="mb-6 flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="tickets-status">Status</Label>
          {/* Radix Select refuses an empty value, hence the `all` sentinel. */}
          <Select
            value={filters.status ?? 'all'}
            onValueChange={(value) =>
              updateFilters({ status: value === 'all' ? undefined : value })
            }
          >
            <SelectTrigger id="tickets-status" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {Object.entries(TICKET_STATUS_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="tickets-category">Category</Label>
          <Select
            value={filters.category ?? 'all'}
            onValueChange={(value) =>
              updateFilters({ category: value === 'all' ? undefined : value })
            }
          >
            <SelectTrigger id="tickets-category" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {Object.entries(CATEGORY_FILTER_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      )}

      {data ? (
        <>
          <TicketsTable
            tickets={data.tickets}
            fetching={fetching}
            emptyText={filtered ? 'No tickets match your filters.' : 'No tickets yet.'}
          />
          {data.total > 0 && (
            <Pagination
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              count={data.tickets.length}
              fetching={fetching}
              onPageChange={(page) => updateFilters({ page: String(page) })}
            />
          )}
        </>
      ) : (
        // Nothing has loaded yet. A skeleton promises content is coming, so it
        // gives way to the alert alone once the first request has failed.
        !query.isError && <TicketsTableSkeleton />
      )}
    </main>
  )
}
