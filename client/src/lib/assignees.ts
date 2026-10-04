/**
 * The assignee list (`GET /api/assignees`) - who a ticket can be given to.
 *
 * Its own module rather than part of `users.ts`, which mirrors the admin-only
 * `/api/users`: this endpoint is readable by every signed-in user and returns a
 * deliberately thinner shape, and keeping the two apart is what stops the
 * admin page's richer `PublicUser` drifting into an agent-visible response.
 */
import { queryOptions } from '@tanstack/react-query'
import { apiFetch, type Role } from './api.ts'

/** Mirrors `AssignableUser` in `server/src/services/users.ts`. */
export type Assignee = {
  id: string
  name: string
  email: string
  role: Role
}

/**
 * One key for the whole list: it takes no parameters, and a write that changed
 * who can be assigned - deactivating a user, say - invalidates all of it.
 */
export const assigneeKeys = {
  all: ['assignees'] as const,
}

export function assigneeListQueryOptions() {
  return queryOptions({
    queryKey: assigneeKeys.all,
    queryFn: ({ signal }) => listAssignees(signal),
  })
}

export async function listAssignees(signal?: AbortSignal): Promise<Assignee[]> {
  const { assignees } = await apiFetch<{ assignees: Assignee[] }>('/api/assignees', { signal })
  return assignees
}
