import { Navigate, Outlet, useLocation } from 'react-router'
import { useAuth } from './auth-context.ts'

/**
 * Gates its child routes on a session. Anonymous visitors go to the login
 * page, which sends them back here once they are in.
 */
export function ProtectedRoute() {
  const auth = useAuth()
  const location = useLocation()

  if (auth.status === 'loading') {
    return (
      <main className="page page--centred">
        <p className="muted">Loading…</p>
      </main>
    )
  }

  if (auth.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return <Outlet />
}
