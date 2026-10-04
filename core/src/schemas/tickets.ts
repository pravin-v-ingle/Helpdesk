/**
 * Validation shared by the reply composer and `POST /api/tickets/:id/messages`.
 * One definition, so the form and the API cannot disagree about what a usable
 * reply is - and the 400 the server returns carries the message the form would
 * have shown.
 *
 * Only the reply body lives here. A ticket itself is never posted from a form:
 * it arrives as a provider's webhook payload, validated in that provider's
 * adapter, and its assignee, status and category are changed through
 * `PATCH /api/tickets/:id`, whose body is three server-owned enum fields the
 * route reads one key at a time.
 */
import { z } from 'zod'
import { text } from './text.ts'

/**
 * Body of `POST /api/tickets/:id/messages`, and the one field of the reply
 * composer.
 *
 * `.trim()` is a transform, not a check: whitespace goes before the length
 * rules run, so a reply of nothing but newlines is the empty one it really is,
 * and the trimmed text is what gets stored.
 *
 * The ceiling is far below the 256 KB an inbound email body is truncated to
 * (`MAX_BODY_LENGTH` in `server/src/lib/email/strip-quoted-reply.ts`) and below
 * `express.json()`'s own 100 KB default, which would otherwise refuse the
 * request with a message written by Express rather than by us. Ten thousand
 * characters is around fifteen hundred words - long for a support reply, and
 * short enough that the list view cannot be wrecked by one.
 */
export const ticketReplySchema = z.object({
  body: text('Reply')
    .trim()
    .min(1, 'Reply is required.')
    .max(10_000, 'Reply must be at most 10,000 characters.'),
})

export type TicketReplyInput = z.infer<typeof ticketReplySchema>
