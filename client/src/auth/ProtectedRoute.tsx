import { Navigate, Outlet, useLocation } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from './auth-context.ts'

/**
 * Gates its child routes on a session. Anonymous visitors go to the login
 * page, which sends them back here once they are in.
 */
export function ProtectedRoute() {
  const auth = useAuth()
  const location = useLocation()

  if (auth.status === 'loading') return <ShellSkeleton />

  if (auth.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return <Outlet />
}

/**
 * Stands in for `AppLayout` while `GET /api/me` is in flight on a page load:
 * the same nav bar strip and page padding, so the real shell lands in place
 * rather than pushing a centred message out of the way.
 */
function ShellSkeleton() {
  return (
    <div role="status" aria-label="Loading">
      <div className="flex items-center justify-between gap-4 border-b px-6 py-3">
        <Skeleton className="h-6 w-24" />
        <div className="flex items-center gap-3">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-5 w-14 rounded-full" />
          <Skeleton className="h-8 w-20" />
        </div>
      </div>
      <main className="flex-1 px-6 py-8">
        <Skeleton className="mb-6 h-8 w-48" />
        <div className="flex flex-col gap-3">
          <Skeleton className="h-4 w-full max-w-md" />
          <Skeleton className="h-4 w-full max-w-sm" />
          <Skeleton className="h-4 w-full max-w-xs" />
        </div>
      </main>
    </div>
  )
}
