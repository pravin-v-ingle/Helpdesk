/**
 * Mailgun's inbound Routes webhook. The default provider, because it is the one
 * of the two that actually signs its payloads.
 *
 * Docs: https://documentation.mailgun.com/docs/mailgun/user-manual/mg_routes/
 * and the "Securing webhooks" section on webhook signing.
 */
import { createHmac } from "node:crypto";
import { env } from "../../env.ts";
import { parseAddress, parseMessageId, parseMessageIds, truncate } from "./address.ts";
import {
  constantTimeEquals,
  detectAutoReply,
  MAX_SUBJECT_LENGTH,
  NO_SUBJECT,
  pickRecipient,
  type InboundContext,
  type InboundEmail,
  type InboundProvider,
} from "./inbound-email.ts";
import { field } from "./multipart.ts";
import { MAX_BODY_LENGTH, stripQuotedReply } from "./strip-quoted-reply.ts";

/**
 * How old a signed payload may be. Mailgun's signature covers the timestamp,
 * so without this check a payload captured once could be replayed forever -
 * the signature stays valid indefinitely. Fifteen minutes is generous enough
 * for Mailgun's own retries and clock skew between the two machines.
 */
const MAX_SIGNATURE_AGE_MS = 15 * 60 * 1000;

export const mailgunProvider: InboundProvider = {
  id: "MAILGUN",

  /**
   * `HMAC-SHA256(signing key, timestamp + token)` against the `signature`
   * field, compared in constant time, plus the freshness window above.
   *
   * Note what is *not* checked: the body bytes. Mailgun's scheme signs only
   * the timestamp and token, so the signature proves the request came from
   * Mailgun and is recent, not that the fields are unmodified in transit. TLS
   * is what covers the body. That is Mailgun's design, not a shortcut here.
   */
  verify({ fields }) {
    const timestamp = field(fields, "timestamp");
    const token = field(fields, "token");
    const signature = field(fields, "signature");
    if (!timestamp || !token || !signature) return false;

    // Seconds since the epoch, as Mailgun sends it.
    const sentAt = Number(timestamp);
    if (!Number.isFinite(sentAt)) return false;
    const age = Date.now() - sentAt * 1000;
    if (age > MAX_SIGNATURE_AGE_MS || age < -MAX_SIGNATURE_AGE_MS) return false;

    const expected = createHmac("sha256", env.inboundEmail.secret)
      .update(timestamp + token)
      .digest("hex");

    return constantTimeEquals(signature, expected);
  },

  parse({ fields, attachments }): InboundEmail | null {
    const headers = collectHeaders(fields);

    // `sender` is the envelope sender Mailgun resolved; `from` is the header,
    // which carries the display name. The header is preferred for that reason,
    // with the envelope as the fallback when a From header is missing or junk.
    const from = parseAddress(field(fields, "from", "From")) ?? parseAddress(field(fields, "sender"));
    // No usable sender: authentic, but there is no one to file the ticket
    // under and no one to reply to. Stored with an error, not converted.
    if (!from) return null;

    const body = field(fields, "body-plain") ?? "";
    const stripped = field(fields, "stripped-text");

    // The threading headers are read from the promoted fields *and* from the
    // header block, in that order. Mailgun usually promotes all three, but
    // "usually" is not good enough for the fields threading depends on: with no
    // Message-ID a mail falls back to a content fingerprint, so a reply would
    // open its own ticket and two similar messages would look like one.
    return {
      rfcMessageId: parseMessageId(field(fields, "Message-Id", "message-id") ?? headers["message-id"]),
      from,
      recipient: pickRecipient(field(fields, "recipient", "To", "to") ?? headers["to"]),
      subject:
        truncate((field(fields, "subject", "Subject") ?? headers["subject"] ?? "").trim(), MAX_SUBJECT_LENGTH) ||
        NO_SUBJECT,
      body: truncate(body, MAX_BODY_LENGTH),
      // Mailgun's own strip is better than the heuristics in
      // `strip-quoted-reply.ts` - it has the whole MIME tree to work from -
      // so it is used when offered and that file is only the fallback.
      strippedBody: truncate(stripped ?? stripQuotedReply(body), MAX_BODY_LENGTH),
      bodyHtml: field(fields, "body-html"),
      inReplyTo: parseMessageId(field(fields, "In-Reply-To", "in-reply-to") ?? headers["in-reply-to"]),
      references: parseMessageIds(field(fields, "References", "references") ?? headers["references"]),
      headers,
      attachments,
      autoReply: detectAutoReply(headers, from.email),
    };
  },
};

/**
 * Every header Mailgun exposed, lowercased.
 *
 * Mailgun sends the full set as a JSON array of `[name, value]` pairs in
 * `message-headers`, and separately promotes the common ones to their own
 * fields. Both are read, the JSON first, so a header only present as a field
 * (or one Mailgun renamed) is still seen. A malformed `message-headers` is
 * ignored rather than failing the whole parse - the promoted fields are enough
 * to build a ticket, and losing a ticket over a header blob would be worse.
 */
function collectHeaders(fields: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};

  // The promoted fields first, so a real header of the same name wins below.
  for (const [key, value] of Object.entries(fields)) {
    if (RESERVED_FIELDS.has(key.toLowerCase())) continue;
    headers[key.toLowerCase()] = value;
  }

  const raw = field(fields, "message-headers");
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (!Array.isArray(entry) || entry.length < 2) continue;
          const [name, value] = entry as [unknown, unknown];
          if (typeof name === "string" && typeof value === "string") {
            headers[name.toLowerCase()] = value;
          }
        }
      }
    } catch {
      // Not JSON. The promoted fields above stand on their own.
    }
  }

  return headers;
}

/**
 * Mailgun's own fields, which are not mail headers and would otherwise be
 * mistaken for them - `timestamp` and `token` especially, which mean something
 * quite different in this context.
 */
const RESERVED_FIELDS = new Set([
  "body-plain",
  "body-html",
  "stripped-text",
  "stripped-html",
  "stripped-signature",
  "message-headers",
  "content-id-map",
  "attachment-count",
  "timestamp",
  "token",
  "signature",
  "recipient",
  "sender",
]);
