/**
 * Validation shared by the client form and the server route for the same
 * request. One definition, so the two can never disagree about what a valid
 * new user is. Nothing here may depend on the browser, Bun, Express or
 * Prisma - this package is imported by both sides.
 */
import { z } from 'zod'

/**
 * A text field with one message whether the key is missing or the wrong type.
 * The form never sends `undefined` (every field is defaulted to `''`), so this
 * is for the API, where the body is whatever the caller chose to send.
 */
const text = (label: string) =>
  z.string({
    error: (issue) => (issue.input === undefined ? `${label} is required.` : `${label} must be text.`),
  })

/**
 * Body of `POST /api/users`, and the fields of the create-user dialog. `role`
 * is not here: it is server-owned and the route defaults it.
 *
 * `.trim()` is a transform, not a check - names and emails are trimmed before
 * the length rules run, and the trimmed value is what comes out. The password
 * is never trimmed: it must reach the hash exactly as typed, or the account
 * could not sign in with the password the admin handed over. Its bounds are
 * Better Auth's defaults (8-128), which `server/src/lib/auth-accounts.ts`
 * enforces again from the live configuration.
 */
export const createUserSchema = z.object({
  name: text('Name').trim().min(3, 'Name must be at least 3 characters.'),
  // Piped rather than `.email()`, which Zod 4 deprecates, and it short-circuits:
  // a blank field reports "required", not that plus "invalid".
  email: text('Email')
    .trim()
    .min(1, 'Email is required.')
    .pipe(z.email('Email must be a valid email address.')),
  password: text('Password')
    .min(8, 'Password must be at least 8 characters.')
    .max(128, 'Password must be at most 128 characters.'),
})

export type CreateUserInput = z.infer<typeof createUserSchema>
