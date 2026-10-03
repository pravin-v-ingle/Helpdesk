/**
 * The admin users API (`/api/users`). Transport stays in `api.ts`; this file
 * knows the endpoint's parameters and response shape.
 */
import type { CreateUserInput, EditUserInput } from '@helpdesk/core/schemas/users'
import { queryOptions } from '@tanstack/react-query'
import { apiFetch, type PublicUser, type Role } from './api.ts'
import type { SortDir } from './sorting.ts'

/** Mirrors `UserStatus` in `server/src/services/users.ts`. */
export type UserStatus = 'active' | 'inactive' | 'deleted'

/**
 * The columns `GET /api/users` can order by. Mirrors `UserSortBy` in
 * `server/src/services/users.ts`, and the members are exactly the column ids
 * `UsersTable` gives TanStack Table. Actions is absent: it is not a column of
 * anything. A `Record` keyed by itself, so adding a member is a compile error
 * until it has an entry.
 */
const USER_SORT_BYS = {
  name: true,
  email: true,
  role: true,
  status: true,
  createdAt: true,
} as const

export type UserSortBy = keyof typeof USER_SORT_BYS

export function isUserSortBy(value: unknown): value is UserSortBy {
  return typeof value === 'string' && Object.hasOwn(USER_SORT_BYS, value)
}

export type UserListParams = {
  q?: string
  role?: Role
  status?: UserStatus
  /** Both keys or neither; absent means the server's default composite order. */
  sortBy?: UserSortBy
  sortDir?: SortDir
  page?: number
  pageSize?: number
}

/** Mirrors the body of `GET /api/users` in `server/src/routes/users.ts`. */
export type UserListResponse = {
  users: PublicUser[]
  total: number
  page: number
  pageSize: number
}

/**
 * Query keys for everything under `/api/users`. `all` is what a write
 * invalidates - `createUser` callers do, and edit will do the same - so every
 * cached page refetches; the list key carries its params so each page and
 * filter combination is cached on its own.
 */
export const userKeys = {
  all: ['users'] as const,
  list: (params: UserListParams) => [...userKeys.all, 'list', params] as const,
}

export function userListQueryOptions(params: UserListParams) {
  return queryOptions({
    queryKey: userKeys.list(params),
    queryFn: ({ signal }) => listUsers(params, signal),
  })
}

export function listUsers(params: UserListParams, signal?: AbortSignal): Promise<UserListResponse> {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  const query = search.toString()

  return apiFetch<UserListResponse>(query ? `/api/users?${query}` : '/api/users', { signal })
}

/**
 * Creates a user and returns it. The body type is the shared schema's output
 * (`@helpdesk/core`), the same one the route parses; `role` is omitted and
 * the server defaults it to AGENT. A duplicate email rejects with a 409.
 */
export async function createUser(input: CreateUserInput): Promise<PublicUser> {
  const { user } = await apiFetch<{ user: PublicUser }>('/api/users', { method: 'POST', body: input })
  return user
}

/**
 * Updates a user and returns the saved row. The body type is the edit form's
 * schema output (`@helpdesk/core`), where a blank password has already become
 * `undefined` - so an untouched password field sends no `password` key and the
 * server leaves the account's password alone. A duplicate email rejects with a
 * 409, the same as create.
 */
export async function updateUser(id: string, input: EditUserInput): Promise<PublicUser> {
  const { user } = await apiFetch<{ user: PublicUser }>(`/api/users/${id}`, {
    method: 'PATCH',
    body: input,
  })
  return user
}

/**
 * Deletes a user and returns the saved row - a soft delete, so the row comes
 * back with `deletedAt` set and `active: false` rather than disappearing from
 * the list. Refused with a 400 for an admin, or for the caller's own account.
 */
export async function deleteUser(id: string): Promise<PublicUser> {
  const { user } = await apiFetch<{ user: PublicUser }>(`/api/users/${id}`, { method: 'DELETE' })
  return user
}
