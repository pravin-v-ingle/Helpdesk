import { useAuth } from '../auth/auth-context.ts'

/**
 * Placeholder home page. `project-scope.md` does not say what `/` shows; the
 * dashboard in phase 7 replaces this.
 */
export function HomePage() {
  const auth = useAuth()
  if (auth.status !== 'authenticated') return null

  const { user } = auth

  return (
    <main className="flex-1 px-6 py-8">
      <h1 className="mb-3 text-3xl font-medium tracking-tight text-gray-950 dark:text-gray-100">
        Welcome, {user.name}
      </h1>
      <p className="text-[15px]">
        You are signed in as {user.email} with the{' '}
        {user.role === 'ADMIN' ? 'admin' : 'agent'} role.
      </p>
    </main>
  )
}
