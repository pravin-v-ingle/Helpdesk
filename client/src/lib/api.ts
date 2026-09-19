/**
 * The one place that knows how this API talks: relative `/api` paths, session
 * cookies, and the server's single-key `{ error }` failure shape.
 */
import axios, { type Method } from 'axios'

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
 * No `baseURL`: paths are relative to the page's origin, which Vite proxies to
 * the API in development. Same origin means the session cookie rides along
 * without `withCredentials`, which only governs cross-origin requests.
 */
const http = axios.create()

export type ApiRequestOptions = {
  method?: Method
  /** Serialised as JSON; Axios sets the `Content-Type` header itself. */
  body?: unknown
  signal?: AbortSignal
}

/**
 * Call a JSON endpoint. Throws `ApiError` on a non-2xx response, so callers
 * only deal with the success shape. A request that never reached the server
 * (network down, or aborted through `signal`) rejects with Axios's own error,
 * which is how callers tell the two apart.
 */
export async function apiFetch<T>(path: string, options?: ApiRequestOptions): Promise<T> {
  try {
    const res = await http.request<T>({
      url: path,
      method: options?.method ?? 'GET',
      data: options?.body,
      signal: options?.signal,
    })
    return res.data
  } catch (err) {
    if (!axios.isAxiosError(err) || !err.response) throw err

    const { status, data } = err.response
    if (status === 401) onUnauthorized?.()
    throw new ApiError(status, errorMessage(status, data))
  }
}

/**
 * Every server failure is `{ error: string }` (see
 * `server/src/middleware/error-handler.ts`), but a proxy or a crash can still
 * produce something else - Axios hands non-JSON bodies over as a string - so
 * fall back to the status line.
 */
function errorMessage(status: number, body: unknown): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const { error } = body as { error: unknown }
    if (typeof error === 'string') return error
  }
  return `Request failed with status ${status}`
}
