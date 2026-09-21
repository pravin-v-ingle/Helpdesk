import { Navigate, Outlet } from 'react-router'
import type { Role } from '../lib/api.ts'
import { useAuth } from './auth-context.ts'

/**
 * Gates its child routes on the signed-in user's role. Mount it inside
 * `ProtectedRoute`, which has already resolved the session, so there is always
 * a user here. The wrong role is sent home rather than to the login page: the
 * session is valid, the user just cannot see this page.
 */
export function RequireRole({ role }: { role: Role }) {
  const auth = useAuth()

  if (auth.status !== 'authenticated' || auth.user.role !== role) {
    return <Navigate to="/" replace />
  }

  return <Outlet />
}
