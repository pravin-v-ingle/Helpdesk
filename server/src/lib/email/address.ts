/**
 * Reading the small pieces of an email header: an address with an optional
 * display name, and the message-id lists that threading walks.
 *
 * Deliberately not a full RFC 5322 parser. Inbound mail reaches us through a
 * provider that has already done the hard part - Mailgun hands over a parsed
 * `from`, SendGrid a single `from` header line - so what is left is the common
 * shapes, with a fallback that never throws.
 *
 * RFC 2047 encoded words (`=?UTF-8?B?SGVsbG8=?=`) are NOT decoded here.
 * Mailgun decodes them before we see them; SendGrid does not, so a SendGrid
 * message from a sender with a non-ASCII name arrives with the encoded word
 * as its display name. That is deliberate: a correct decoder is charset
 * tables and base64/quoted-printable handling for a cosmetic gain, and a
 * half-correct one is a parser bug in the path every email takes. The
 * mojibake is visible, harmless, and fixed by a real MIME library if it ever
 * matters.
 */

/** Longest display name kept. Hostile input is otherwise unbounded. */
const MAX_NAME_LENGTH = 200;

export type EmailAddress = { email: string; name: string };

/**
 * Pulls the address and display name out of a From/To header value.
 *
 * Handles `Ada Lovelace <ada@example.com>`, `"Lovelace, Ada"
 * <ada@example.com>`, a bare `ada@example.com`, and a list, of which the first
 * entry wins - a From header with several addresses is legal and vanishingly
 * rare, and the first is the sender every mail client shows.
 *
 * Returns `null` when there is no address at all, which the caller treats as
 * an unusable payload rather than inventing a sender.
 */
export function parseAddress(raw: string | undefined): EmailAddress | null {
  if (!raw) return null;

  const first = firstEntry(raw);
  const angled = /<([^<>]+)>/.exec(first);

  // `angled[1]` is the one capture group, so it is present whenever the match
  // is; `noUncheckedIndexedAccess` cannot see that.
  const email = (angled ? angled[1]! : first).trim().replace(/^mailto:/i, "").toLowerCase();
  if (!isEmailish(email)) return null;

  // Whatever preceded the angle brackets is the display name, unquoted. With
  // no brackets there is no name, so the address's local part stands in - the
  // column is required precisely so that no view has to cope with its absence.
  const label = angled ? first.slice(0, angled.index).trim() : "";
  const name = unquote(label) || localPart(email);

  return { email, name: truncate(name, MAX_NAME_LENGTH) };
}

/**
 * Splits an address list on the first top-level comma. A comma inside a quoted
 * display name (`"Lovelace, Ada" <ada@example.com>`) does not separate
 * entries, so quotes are tracked rather than the string simply being split.
 */
function firstEntry(raw: string): string {
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) return raw.slice(0, i);
  }
  return raw;
}

/**
 * A liberal check: one `@`, something either side, no whitespace or angle
 * brackets. Validating an address properly is famously not worth it, and the
 * address is never used to send to - only stored and displayed - so the job
 * here is only to reject a field that plainly is not an address.
 */
function isEmailish(value: string): boolean {
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
}

function localPart(email: string): string {
  return email.slice(0, email.indexOf("@"));
}

/** Strips surrounding double quotes and unescapes what RFC 5322 escapes. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || trimmed.length < 2) return trimmed;
  return trimmed.slice(1, -1).replace(/\\(.)/g, "$1").trim();
}

export function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** How many message ids a References header may contribute to the threading walk. */
const MAX_MESSAGE_IDS = 50;

/**
 * Pulls the ids out of a Message-ID, In-Reply-To or References header, with
 * the angle brackets stripped - the form `Message.rfcMessageId` stores, so a
 * lookup compares like with like.
 *
 * References is a space-separated list that grows by one id per reply, so a
 * long thread can carry dozens; the list is capped because it becomes an `IN`
 * clause. The cap keeps the *last* ids, which are the closest ancestors and
 * therefore the ones most likely to be ours.
 */
export function parseMessageIds(header: string | undefined): string[] {
  if (!header) return [];

  const ids = [...header.matchAll(/<([^<>\s]+)>/g)].map((match) => match[1]!);
  // A header that is a bare id with no brackets is technically malformed but
  // does turn up; take it whole rather than finding nothing.
  if (ids.length === 0) {
    const bare = header.trim();
    if (bare && !/\s/.test(bare)) ids.push(bare);
  }

  const unique = [...new Set(ids)];
  return unique.length > MAX_MESSAGE_IDS ? unique.slice(-MAX_MESSAGE_IDS) : unique;
}

/** The first id in a header, for Message-ID and In-Reply-To, which carry one. */
export function parseMessageId(header: string | undefined): string | undefined {
  return parseMessageIds(header)[0];
}
