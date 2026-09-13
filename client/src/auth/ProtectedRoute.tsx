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
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-8">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    )
  }

  if (auth.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return <Outlet />
}
