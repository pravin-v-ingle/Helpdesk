import { useState } from 'react'
import { useAuth } from '../auth/auth-context.ts'

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
    <header className="navbar">
      <span className="navbar__brand">Helpdesk</span>

      {user && (
        <div className="navbar__user">
          <span className="navbar__name">{user.name}</span>
          <span className="badge">{user.role === 'ADMIN' ? 'Admin' : 'Agent'}</span>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => void handleSignOut()}
            disabled={signingOut}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </header>
  )
}
