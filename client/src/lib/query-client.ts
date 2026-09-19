import { QueryClient } from '@tanstack/react-query'
import { ApiError } from './api.ts'

/**
 * The one TanStack Query cache for the app, provided in `main.tsx`. Each
 * resource's query definitions live beside its API client
 * (`lib/users.ts` → `userListQueryOptions`), so pages only pick a key.
 *
 * A 4xx will not change on retry - it is a bad request, a lost session or a
 * missing role - so only server and network failures are retried, and once,
 * so an outage shows up in a couple of seconds rather than after the
 * library's default three backoffs.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status < 500) return false
        return failureCount < 1
      },
    },
  },
})
