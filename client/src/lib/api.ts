/**
 * The one place that knows how this API talks: relative `/api` paths, session
 * cookies, and the server's single-key `{ error }` failure shape.
 */

/**
 * The user shape every endpoint returns, mirroring `publicUserSelect` in
 * `server/src/services/users.ts`. Declared here rather than imported from the
 * server workspace: the client tsconfig only includes `src`, and reaching
 * across would drag Bun and the generated Prisma types into the client build.
 * Dates are strings because they arrive as JSON.
 */
export type PublicUser = {
  id: string
  name: string
  email: string
  role: 'ADMIN' | 'AGENT'
  active: boolean
  createdAt: string
  updatedAt: string
}

/**
 * A non-2xx response, carrying the status and the server's message. The status
 * is assigned in the body rather than declared as a constructor parameter
 * property, which `erasableSyntaxOnly` in the client tsconfig disallows.
 */
export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type UnauthorizedHandler = () => void

let onUnauthorized: UnauthorizedHandler | undefined

/**
 * Register what happens when any request comes back 401 - task 2.14.
 * `AuthProvider` registers a handler that clears the user, which makes
 * `ProtectedRoute` send the browser to `/login`.
 *
 * Note that `requireRole` answers with 403, not 401, deliberately: a valid
 * session hitting an admin-only route must not be bounced to the login page.
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | undefined) {
  onUnauthorized = handler
}

/**
 * Fetch a JSON endpoint. Throws `ApiError` on a non-2xx response, so callers
 * only deal with the success shape.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    // Same origin in development too, because Vite proxies /api.
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.()
    throw new ApiError(res.status, await errorMessage(res))
  }

  return (await res.json()) as T
}

/**
 * Every server failure is `{ error: string }` (see
 * `server/src/middleware/error-handler.ts`), but a proxy or a crash can still
 * produce something else, so fall back to the status line.
 */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json()
    if (body && typeof body === 'object' && 'error' in body) {
      const { error } = body as { error: unknown }
      if (typeof error === 'string') return error
    }
  } catch {
    // Not JSON. Fall through.
  }
  return `Request failed with status ${res.status}`
}
