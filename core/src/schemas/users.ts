/**
 * Validation shared by the client forms and the server routes for the same
 * requests. One definition, so the two can never disagree about what a valid
 * user is. Nothing here may depend on the browser, Bun, Express or Prisma -
 * this package is imported by both sides.
 */
import { z } from 'zod'

/**
 * A text field with one message whether the key is missing or the wrong type.
 * The forms never send `undefined` (every field is defaulted to `''`), so this
 * is for the API, where the body is whatever the caller chose to send.
 */
const text = (label: string) =>
  z.string({
    error: (issue) => (issue.input === undefined ? `${label} is required.` : `${label} must be text.`),
  })

// --- fields -----------------------------------------------------------------
// Declared once and composed into the schemas below, so create and edit cannot
// drift apart on what a name or an email is.

/**
 * `.trim()` is a transform, not a check: the name and email are trimmed before
 * their length rules run, and the trimmed value is what comes out.
 */
const nameField = text('Name').trim().min(3, 'Name must be at least 3 characters.')

/**
 * Piped rather than `.email()`, which Zod 4 deprecates, and it short-circuits:
 * a blank field reports "required", not that plus "invalid".
 *
 * Lowercased here so one address cannot be stored two ways. The uniqueness
 * check and the sign-in lookup both compare the stored value, so the
 * normalisation has to happen before either of them sees it.
 */
const emailField = text('Email')
  .trim()
  .toLowerCase()
  .min(1, 'Email is required.')
  .pipe(z.email('Email must be a valid email address.'))

/**
 * Never trimmed: the password must reach the hash exactly as typed, or the
 * account could not be signed into with the password the admin handed over.
 * The bounds are Better Auth's defaults, which
 * `server/src/lib/auth-accounts.ts` enforces again from the live config.
 */
const passwordField = text('Password')
  .min(8, 'Password must be at least 8 characters.')
  .max(128, 'Password must be at most 128 characters.')

/**
 * A password that may be left alone. Blank *or absent* means "no change" and
 * becomes `undefined`, so a caller downstream only has to ask whether it is
 * set - `''` never reaches the service. A value that is present still has to
 * satisfy the same bounds, with the same messages.
 *
 * `.optional()` comes first on purpose: it short-circuits `undefined` before
 * the string check can call it a missing field, which is what lets
 * `PATCH { role }` carry no password at all.
 */
const optionalPasswordField = text('Password')
  .optional()
  .transform((value) => (value === undefined || value === '' ? undefined : value))
  .pipe(passwordField.optional())

// --- schemas ----------------------------------------------------------------

/**
 * Body of `POST /api/users`, and the fields of the create-user dialog. `role`
 * is not here: it is server-owned and the route defaults it to AGENT.
 */
export const createUserSchema = z.object({
  name: nameField,
  email: emailField,
  password: passwordField,
})

export type CreateUserInput = z.infer<typeof createUserSchema>

/**
 * What the edit-user dialog submits: the identity fields are required, because
 * the form always shows them filled in, and the password is optional - left
 * blank, the account keeps the one it has.
 */
export const editUserSchema = z.object({
  name: nameField,
  email: emailField,
  password: optionalPasswordField,
})

export type EditUserInput = z.infer<typeof editUserSchema>

/**
 * Body of `PATCH /api/users/:id`, which is a partial update: every field here
 * is optional, so the older `{ role }` and `{ active }` callers keep working
 * untouched (Zod drops keys a schema does not declare, and `role` and `active`
 * are read straight off the body by the route - they are server-owned and
 * never come from this form).
 */
export const updateUserSchema = z.object({
  name: nameField.optional(),
  email: emailField.optional(),
  password: optionalPasswordField,
})

export type UpdateUserInput = z.infer<typeof updateUserSchema>

/**
 * The fields both dialogs bind to. Every one is a string - blank rather than
 * absent - so an input is never uncontrolled and both forms share one shape.
 */
export type UserFormValues = z.input<typeof editUserSchema>
