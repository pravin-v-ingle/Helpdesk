/**
 * Cutting the quoted history and the signature off a plain-text reply, so a
 * message stored on a ticket is what the student actually wrote this time
 * (task 4.8). What the agent reads, and what Phase 5 sends to Claude.
 *
 * Heuristics, not parsing: there is no marker in a mail body that says "the
 * quote starts here", only a handful of conventions that mail clients happen
 * to share. Mailgun does this better than anything written here and its
 * `stripped-text` is preferred when present (see `mailgun.ts`); this is the
 * fallback for SendGrid and for Mailgun payloads that lack it.
 *
 * Biased towards keeping too much. A reply that arrives with a quote attached
 * is untidy; one truncated at a line that looked like a signature has lost
 * what the student said, and nothing else stores it.
 */

/**
 * Lines that begin quoted history. Anchored at the start of a line, and each
 * must look like a machine-generated attribution rather than prose - a body
 * whose first line is "On Monday I tried to log in" must survive.
 */
const QUOTE_HEADERS: RegExp[] = [
  // "On Mon, 4 May 2026 at 10:02, Ada Lovelace <ada@example.com> wrote:"
  // The date part varies wildly between clients, so only the shape is matched.
  /^\s*On\s.{0,200}\bwrote:\s*$/i,
  // Outlook and friends: a divider line, then From:/Sent:/To:/Subject:.
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*-{3,}\s*Forwarded message\s*-{3,}\s*$/i,
  /^\s*_{10,}\s*$/,
  /^\s*From:\s*.+$/i,
  // Apple Mail and some webmail clients.
  /^\s*Sent from my \w+/i,
  /^\s*\S.{0,200}\swrote:\s*$/i,
];

/**
 * The signature separator RFC 3676 defines: exactly "-- " on its own line.
 * Matched without the trailing space too, because clients strip it, but not
 * as part of a longer run of dashes, which is an ordinary divider.
 */
const SIGNATURE_SEPARATOR = /^--\s*$/;

/** Longest body kept. Postgres `text` would store megabytes without complaint. */
export const MAX_BODY_LENGTH = 256 * 1024;

/**
 * Returns the body with quoted history and a trailing signature removed, and
 * length-capped. Never returns a longer string than it was given, and returns
 * the original (trimmed and capped) when no marker is found.
 */
export function stripQuotedReply(text: string): string {
  const lines = capped(text).split(/\r?\n/);

  let cut = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // A run of `>`-quoted lines. Taken as the start of the quote only when
    // there is something above it, so a reply that is nothing but a quote is
    // left alone rather than emptied.
    if (line.startsWith(">") && i > 0) {
      cut = i;
      break;
    }

    if (QUOTE_HEADERS.some((pattern) => pattern.test(line))) {
      cut = i;
      break;
    }

    if (SIGNATURE_SEPARATOR.test(line) && i > 0) {
      cut = i;
      break;
    }
  }

  const kept = lines.slice(0, cut).join("\n").trim();

  // Everything looked like a quote. Better the untidy original than an empty
  // message: an empty body on a ticket tells the agent nothing at all.
  return kept === "" ? capped(text).trim() : kept;
}

function capped(text: string): string {
  return text.length > MAX_BODY_LENGTH ? text.slice(0, MAX_BODY_LENGTH) : text;
}
