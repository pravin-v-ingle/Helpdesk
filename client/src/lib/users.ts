/**
 * The admin users API (`/api/users`). Transport stays in `api.ts`; this file
 * knows the endpoint's parameters and response shape.
 */
import { queryOptions } from '@tanstack/react-query'
import { apiFetch, type PublicUser } from './api.ts'

export type UserListParams = {
  q?: string
  role?: PublicUser['role']
  active?: boolean
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
 * Query keys for everything under `/api/users`. `all` is what a write should
 * invalidate once 2.13b adds create and edit; the list key carries its params
 * so each page and filter combination is cached on its own.
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
