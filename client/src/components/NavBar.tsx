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
    <header className="flex items-center justify-between gap-4 border-b border-gray-200 px-6 py-3 dark:border-gray-800">
      <span className="text-xl font-medium tracking-tight text-gray-950 dark:text-gray-100">
        Helpdesk
      </span>

      {user && (
        <div className="flex items-center gap-3">
          <span className="text-[15px] text-gray-950 dark:text-gray-100">{user.name}</span>
          <span className="rounded-full border border-purple-600/50 bg-purple-600/10 px-2 py-1 text-xs leading-none text-purple-600 dark:border-purple-400/50 dark:bg-purple-400/15 dark:text-purple-400">
            {user.role === 'ADMIN' ? 'Admin' : 'Agent'}
          </span>
          <button
            type="button"
            className="cursor-pointer rounded-lg border border-gray-200 px-4 py-2 text-[15px] text-gray-950 enabled:hover:border-purple-600/50 enabled:hover:text-purple-600 disabled:cursor-default disabled:opacity-60 dark:border-gray-800 dark:text-gray-100 dark:enabled:hover:border-purple-400/50 dark:enabled:hover:text-purple-400"
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
