import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { z } from 'zod'
import { useAuth } from '../auth/auth-context.ts'

/**
 * Client-side shape only. The server is still the authority on whether the
 * credentials are any good; this just avoids a round trip for an empty field
 * or an obvious typo in the address.
 *
 * No minimum length on the password: the rule lives in Better Auth's password
 * config, and guessing at it here would only invent a second, wrong one.
 */
const loginSchema = z.object({
  // Piped rather than `.email()`, which Zod 4 deprecates, and it short-circuits:
  // a blank field reports "enter your email", not that plus "invalid address".
  email: z
    .string()
    .trim()
    .min(1, 'Enter your email address.')
    .pipe(z.email('Enter a valid email address.')),
  password: z.string().min(1, 'Enter your password.'),
})

type LoginValues = z.infer<typeof loginSchema>

/**
 * There is no sign-up link on purpose: self-registration is disabled on the
 * server, and admins create accounts through `POST /api/users`.
 */
export function LoginPage() {
  const auth = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  })

  // Wherever ProtectedRoute turned us away from, or the home page.
  const from =
    typeof location.state === 'object' &&
    location.state !== null &&
    'from' in location.state &&
    typeof location.state.from === 'string'
      ? location.state.from
      : '/'

  if (auth.status === 'authenticated') return <Navigate to={from} replace />

  const onSubmit = handleSubmit(async ({ email, password }) => {
    try {
      const message = await auth.signIn(email, password)
      if (message) {
        // Whatever the server said - bad credentials, deactivated account.
        // `root` is react-hook-form's slot for errors that belong to the form
        // rather than to one field, and it clears itself on the next submit.
        setError('root', { message })
        return
      }
      void navigate(from, { replace: true })
    } catch {
      setError('root', { message: 'Could not reach the server. Please try again.' })
    }
  })

  return (
    <main className="page page--centred">
      <form className="card" onSubmit={(event) => void onSubmit(event)} noValidate>
        <h1 className="card__title">Sign in</h1>
        <p className="muted">Helpdesk agent and admin access.</p>

        <label className="field" htmlFor="email">
          <span className="field__label">Email</span>
          <input
            id="email"
            type="email"
            className="input"
            autoComplete="username"
            autoFocus
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? 'email-error' : undefined}
            {...register('email')}
          />
          {errors.email && (
            <span id="email-error" className="error error--field">
              {errors.email.message}
            </span>
          )}
        </label>

        <label className="field" htmlFor="password">
          <span className="field__label">Password</span>
          <input
            id="password"
            type="password"
            className="input"
            autoComplete="current-password"
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? 'password-error' : undefined}
            {...register('password')}
          />
          {errors.password && (
            <span id="password-error" className="error error--field">
              {errors.password.message}
            </span>
          )}
        </label>

        {/* Announced to screen readers when sign-in is refused. */}
        <p className="error" role="alert">
          {errors.root?.message}
        </p>

        <button type="submit" className="button" disabled={isSubmitting}>
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
