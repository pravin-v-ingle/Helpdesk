import { createContext, use } from 'react'
import type { PublicUser } from '../lib/api.ts'

/**
 * `loading` exists so a page refresh does not flash past `ProtectedRoute` and
 * bounce a signed-in user to the login page while `GET /api/me` is in flight.
 */
export type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authenticated'; user: PublicUser }

export type AuthValue = AuthState & {
  /** Resolves to an error message when the credentials are refused. */
  signIn: (email: string, password: string) => Promise<string | undefined>
  signOut: () => Promise<void>
}

export const AuthContext = createContext<AuthValue | undefined>(undefined)

/**
 * The current user and the sign in/out actions. Kept in this file rather than
 * beside the provider so oxlint's `react/only-export-components` rule does not
 * fire on a module exporting both a component and a hook.
 */
export function useAuth(): AuthValue {
  const value = use(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>')
  return value
}
