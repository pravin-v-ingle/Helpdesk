import { createAuthClient } from 'better-auth/react'

/**
 * Better Auth browser client.
 *
 * No `baseURL` and no `basePath` on purpose. The client defaults to the page's
 * own origin plus `/api/auth`, which is exactly where the server mounts Better
 * Auth (`basePath: "/api/auth"` in `server/src/lib/auth.ts`). In development
 * Vite proxies `/api` to port 3000, so the same relative path works there and
 * in production without hardcoding a host.
 *
 * Only `signIn.email` and `signOut` are used. The current user comes from
 * `GET /api/me` rather than `useSession()` - see the comment on that route for
 * why: it returns the same `PublicUser` the `/api/users` endpoints return, so
 * the client has one user type rather than two.
 */
export const authClient = createAuthClient()
