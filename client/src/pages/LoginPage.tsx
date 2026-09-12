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
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-8">
      <form
        className="flex w-90 max-w-full flex-col gap-4 rounded-xl border border-gray-200 bg-white p-7 shadow-lg dark:border-gray-800 dark:bg-gray-950 dark:shadow-black/40"
        onSubmit={(event) => void onSubmit(event)}
        noValidate
      >
        <h1 className="text-[28px] font-medium tracking-tight text-gray-950 dark:text-gray-100">
          Sign in
        </h1>
        {/* Pulled up to sit directly under the title. */}
        <p className="-mt-3 text-[15px]">Helpdesk agent and admin access.</p>

        <label className={fieldClass} htmlFor="email">
          <span className={labelClass}>Email</span>
          <input
            id="email"
            type="email"
            className={inputClass}
            autoComplete="username"
            autoFocus
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? 'email-error' : undefined}
            {...register('email')}
          />
          {errors.email && (
            <span id="email-error" className={fieldErrorClass}>
              {errors.email.message}
            </span>
          )}
        </label>

        <label className={fieldClass} htmlFor="password">
          <span className={labelClass}>Password</span>
          <input
            id="password"
            type="password"
            className={inputClass}
            autoComplete="current-password"
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? 'password-error' : undefined}
            {...register('password')}
          />
          {errors.password && (
            <span id="password-error" className={fieldErrorClass}>
              {errors.password.message}
            </span>
          )}
        </label>

        {/* Announced to screen readers when sign-in is refused. Reserves its
            line so the form does not jump when a message appears. */}
        <p className="min-h-5 text-sm text-red-600 dark:text-red-400" role="alert">
          {errors.root?.message}
        </p>

        <button
          type="submit"
          className="cursor-pointer rounded-lg border border-purple-600 bg-purple-600 px-4 py-2.5 text-[15px] text-white enabled:hover:brightness-108 disabled:cursor-default disabled:opacity-60 dark:border-purple-400 dark:bg-purple-400"
          disabled={isSubmitting}
        >
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}

const fieldClass = 'flex flex-col gap-1.5'

const labelClass = 'text-sm text-gray-950 dark:text-gray-100'

const inputClass =
  'rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-base text-gray-950 focus-visible:border-purple-600 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-purple-600/50 aria-invalid:border-red-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 dark:focus-visible:border-purple-400 dark:focus-visible:outline-purple-400/50 dark:aria-invalid:border-red-400'

// Field-level messages sit under their input and only exist when shown, so
// they reserve no space.
const fieldErrorClass = 'text-[13px] text-red-600 dark:text-red-400'
