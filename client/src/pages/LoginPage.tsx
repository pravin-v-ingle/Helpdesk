import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { useAuth } from '../auth/auth-context.ts'

/**
 * There is no sign-up link on purpose: self-registration is disabled on the
 * server, and admins create accounts through `POST /api/users`.
 */
export function LoginPage() {
  const auth = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)

  // Wherever ProtectedRoute turned us away from, or the home page.
  const from =
    typeof location.state === 'object' &&
    location.state !== null &&
    'from' in location.state &&
    typeof location.state.from === 'string'
      ? location.state.from
      : '/'

  if (auth.status === 'authenticated') return <Navigate to={from} replace />

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(undefined)
    setPending(true)

    try {
      const message = await auth.signIn(email, password)
      if (message) {
        setError(message)
        return
      }
      void navigate(from, { replace: true })
    } catch {
      setError('Could not reach the server. Please try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="page page--centred">
      <form className="card" onSubmit={(event) => void handleSubmit(event)}>
        <h1 className="card__title">Sign in</h1>
        <p className="muted">Helpdesk agent and admin access.</p>

        <label className="field" htmlFor="email">
          <span className="field__label">Email</span>
          <input
            id="email"
            name="email"
            type="email"
            className="input"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            required
            autoFocus
          />
        </label>

        <label className="field" htmlFor="password">
          <span className="field__label">Password</span>
          <input
            id="password"
            name="password"
            type="password"
            className="input"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {/* Announced to screen readers when sign-in is refused. */}
        <p className="error" role="alert">
          {error}
        </p>

        <button type="submit" className="button" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
