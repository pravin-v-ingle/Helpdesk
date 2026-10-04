/**
 * The field building blocks the resource schemas are composed from.
 *
 * Internal to the package: deliberately not in `package.json`'s `exports`,
 * because both sides import whole resource schemas and never the pieces one is
 * built from. Nothing here may depend on the browser, Bun, Express or Prisma.
 */
import { z } from 'zod'

/**
 * A text field with one message whether the key is missing or the wrong type.
 * The forms never send `undefined` (every field is defaulted to `''`), so this
 * is for the API, where the body is whatever the caller chose to send.
 */
export const text = (label: string) =>
  z.string({
    error: (issue) => (issue.input === undefined ? `${label} is required.` : `${label} must be text.`),
  })
