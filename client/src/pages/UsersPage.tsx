import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CreateUserDialog } from '../components/CreateUserDialog.tsx'
import { UsersTable, UsersTableSkeleton } from '../components/UsersTable.tsx'
import { useAuth } from '../auth/auth-context.ts'
import { ApiError, isRole, Role } from '../lib/api.ts'
import { userListQueryOptions, type UserListParams, type UserListResponse } from '../lib/users.ts'

// The server's defaults and limits (server/src/routes/users.ts). The URL is
// normalised against them here so the client never sends a value it would
// refuse with a 400.
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100
const MAX_QUERY_LENGTH = 100
const SEARCH_DEBOUNCE_MS = 300

const NETWORK_ERROR = 'Could not reach the server. Please try again.'

type Filters = Required<Pick<UserListParams, 'page' | 'pageSize'>> &
  Pick<UserListParams, 'q' | 'role' | 'active'>

/** Every filter key stored in the URL. `pageSize` is URL-only: no control sets it. */
type FilterPatch = Partial<Record<'q' | 'role' | 'active' | 'page', string | undefined>>

/**
 * The URL is the only source of filter state, so a reload or Back keeps the
 * view. Anything unusable is dropped silently rather than reported.
 */
function readFilters(params: URLSearchParams): Filters {
  const q = params.get('q')?.trim().slice(0, MAX_QUERY_LENGTH)
  const role = params.get('role')
  const active = params.get('active')

  return {
    q: q ? q : undefined,
    role: isRole(role) ? role : undefined,
    active: active === 'true' ? true : active === 'false' ? false : undefined,
    page: readPositiveInt(params.get('page')) ?? 1,
    pageSize: Math.min(readPositiveInt(params.get('pageSize')) ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  }
}

function readPositiveInt(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return parsed >= 1 ? parsed : undefined
}

function totalPagesOf({ total, pageSize }: UserListResponse): number {
  return Math.max(1, Math.ceil(total / pageSize))
}

/**
 * Admin user management: the list, searchable, filterable and paginated, and
 * the create form (`CreateUserDialog`). The page owns the URL state and the
 * query; `UsersTable` renders the rows. Edit/deactivate actions are task 2.13c.
 */
export function UsersPage() {
  const auth = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  // `filters` is part of the query key. It is hashed structurally, so the new
  // object `setSearchParams` produces for an unchanged URL does not refetch.
  const filters = useMemo(() => readFilters(searchParams), [searchParams])

  // `keepPreviousData` shows the previous page's rows while the next page
  // loads, so the table does not collapse to a skeleton on every change. A
  // superseded request is cancelled through the query's `signal`.
  const query = useQuery({ ...userListQueryOptions(filters), placeholderData: keepPreviousData })
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
          // so the plain `/users` URL and "page 1 of the same" are one entry.
          if ('q' in patch || 'role' in patch || 'active' in patch) next.delete('page')
          if (next.get('page') === '1') next.delete('page')
          return next
        },
        { replace },
      )
    },
    [setSearchParams],
  )

  // Typing is debounced into the URL. The input keeps its own text so a
  // trailing space is not trimmed away mid-word.
  const [searchText, setSearchText] = useState(filters.q ?? '')

  useEffect(() => {
    const trimmed = searchText.trim()
    if (trimmed === (filters.q ?? '')) return
    const timer = setTimeout(() => updateFilters({ q: trimmed }), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchText, filters.q, updateFilters])

  // Back/forward changes the URL underneath the input; follow it. Left alone
  // when the input already says the same thing, which is the case after its
  // own debounced write above. Adjusted during render rather than in an
  // effect, so the stale text never reaches the screen.
  const urlQ = filters.q ?? ''
  const [syncedQ, setSyncedQ] = useState(urlQ)
  if (urlQ !== syncedQ) {
    setSyncedQ(urlQ)
    if (searchText.trim() !== urlQ) setSearchText(urlQ)
  }

  // A page past the end (a stale link, or the last row on the last page just
  // moved) snaps to the real last page. Replaced, so Back does not return to it.
  useEffect(() => {
    if (!data) return
    const totalPages = totalPagesOf(data)
    if (data.users.length === 0 && data.total > 0 && data.page > totalPages) {
      updateFilters({ page: String(totalPages) }, true)
    }
  }, [data, updateFilters])

  const currentUserId = auth.status === 'authenticated' ? auth.user.id : undefined
  const filtered =
    filters.q !== undefined || filters.role !== undefined || filters.active !== undefined

  return (
    <main className="flex-1 px-6 py-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <CreateUserDialog />
      </div>

      <div className="mb-6 flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="users-search">Search</Label>
          <Input
            id="users-search"
            type="search"
            placeholder="Search by name or email"
            maxLength={MAX_QUERY_LENGTH}
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            className="w-64"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="users-role">Role</Label>
          {/* Radix Select refuses an empty value, hence the `all` sentinel. */}
          <Select
            value={filters.role ?? 'all'}
            onValueChange={(value) => updateFilters({ role: value === 'all' ? undefined : value })}
          >
            <SelectTrigger id="users-role" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              <SelectItem value={Role.ADMIN}>Admin</SelectItem>
              <SelectItem value={Role.AGENT}>Agent</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="users-status">Status</Label>
          <Select
            value={filters.active === undefined ? 'all' : String(filters.active)}
            onValueChange={(value) => updateFilters({ active: value === 'all' ? undefined : value })}
          >
            <SelectTrigger id="users-status" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="true">Active</SelectItem>
              <SelectItem value="false">Inactive</SelectItem>
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
          <UsersTable
            users={data.users}
            currentUserId={currentUserId}
            fetching={fetching}
            emptyText={filtered ? 'No users match your filters.' : 'No users yet.'}
          />
          {data.total > 0 && (
            <Pagination data={data} fetching={fetching} onPageChange={(page) => updateFilters({ page: String(page) })} />
          )}
        </>
      ) : (
        // Nothing has loaded yet. A skeleton promises content is coming, so it
        // gives way to the alert alone once the first request has failed.
        !query.isError && <UsersTableSkeleton />
      )}
    </main>
  )
}

function Pagination({
  data,
  fetching,
  onPageChange,
}: {
  data: UserListResponse
  fetching: boolean
  onPageChange: (page: number) => void
}) {
  const { page, pageSize, total, users } = data
  const totalPages = totalPagesOf(data)
  const from = (page - 1) * pageSize + 1
  const to = from + users.length - 1

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-4 text-sm text-muted-foreground">
      <p aria-live="polite">
        Showing {from}–{to} of {total}
      </p>
      <div className="flex items-center gap-3">
        <span>
          Page {page} of {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={fetching || page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={fetching || page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  )
}
