import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiFetch, setUnauthorizedHandler } from '../lib/api.ts'
import type { PublicUser } from '../lib/api.ts'
import { authClient } from '../lib/auth-client.ts'
import { AuthContext } from './auth-context.ts'
import type { AuthState } from './auth-context.ts'

/**
 * Ask the server who we are. The session cookie is httpOnly, so this is the
 * only way to find out whether one is still valid; a 401 is the ordinary
 * signed-out answer rather than an error worth surfacing.
 */
async function fetchAuthState(signal?: AbortSignal): Promise<AuthState> {
  try {
    const { user } = await apiFetch<{ user: PublicUser }>('/api/me', { signal })
    return { status: 'authenticated', user }
  } catch {
    return { status: 'anonymous' }
  }
}

/**
 * Holds the signed-in user for the whole app, restores the session on load,
 * and owns signing in and out.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()

    fetchAuthState(controller.signal).then((next) => {
      if (!controller.signal.aborted) setState(next)
    })

    return () => controller.abort()
  }, [])

  // Task 2.14: a 401 from anywhere in the client drops us to anonymous, which
  // makes ProtectedRoute redirect to /login on the next render.
  useEffect(() => {
    setUnauthorizedHandler(() => setState({ status: 'anonymous' }))
    return () => setUnauthorizedHandler(undefined)
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    // Better Auth returns { data, error } rather than throwing, and its
    // endpoints bypass our error handler, so this is its own shape. A
    // deactivated account comes back with the message set by the session
    // hook in server/src/lib/auth.ts.
    const { error } = await authClient.signIn.email({ email, password })
    if (error) return error.message ?? 'Could not sign in. Please try again.'

    setState(await fetchAuthState())
    return undefined
  }, [])

  const signOut = useCallback(async () => {
    await authClient.signOut()
    setState({ status: 'anonymous' })
  }, [])

  const value = useMemo(() => ({ ...state, signIn, signOut }), [state, signIn, signOut])

  return <AuthContext value={value}>{children}</AuthContext>
}
