import { useState } from 'react'
import { NavLink } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAuth } from '../auth/auth-context.ts'
import { Role } from '../lib/api.ts'

export function NavBar() {
  const auth = useAuth()
  const [signingOut, setSigningOut] = useState(false)

  // The nav bar only renders inside ProtectedRoute, so there is always a user.
  const user = auth.status === 'authenticated' ? auth.user : undefined

  async function handleSignOut() {
    setSigningOut(true)
    try {
      await auth.signOut()
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <header className="flex items-center justify-between gap-4 border-b px-6 py-3">
      <nav className="flex items-center gap-4">
        <NavLink to="/" className="text-lg font-semibold tracking-tight">
          Helpdesk
        </NavLink>
        {user?.role === Role.ADMIN && (
          <NavLink
            to="/users"
            className={({ isActive }) =>
              cn(
                'text-sm transition-colors hover:text-foreground',
                isActive ? 'font-medium text-foreground' : 'text-muted-foreground',
              )
            }
          >
            Users
          </NavLink>
        )}
      </nav>

      {user && (
        <div className="flex items-center gap-3">
          <span className="text-sm">{user.name}</span>
          <Badge variant="secondary">{user.role === Role.ADMIN ? 'Admin' : 'Agent'}</Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleSignOut()}
            disabled={signingOut}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </Button>
        </div>
      )}
    </header>
  )
}
