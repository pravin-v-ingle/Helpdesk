/**
 * SendGrid Inbound Parse.
 *
 * Docs: https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/setting-up-the-inbound-parse-webhook
 *
 * **Inbound Parse has no signature mechanism at all.** SendGrid does publish a
 * signed webhook, but that is the Event Webhook - delivery and engagement
 * events for mail you sent - which is a different product and does not carry
 * inbound mail. Inbound Parse simply POSTs to whatever URL is configured, with
 * nothing to prove the request came from SendGrid.
 *
 * The only authentication available is therefore a secret in the URL itself:
 * SendGrid supports HTTP Basic credentials embedded in the parse URL
 * (`https://user:password@host/api/email/inbound`) and sends them on every
 * request. `verify()` below compares that password against
 * `INBOUND_EMAIL_SECRET` in constant time.
 *
 * That is genuinely weaker than Mailgun's HMAC: the secret is a bearer token
 * sent on every request rather than a per-payload signature, so anything that
 * logs URLs or Authorization headers along the path leaks it, and there is no
 * replay window. It is why Mailgun is the default. If this provider is used in
 * production, the webhook must be HTTPS-only and the secret rotated like a
 * password, not treated as a signing key.
 */
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

export const sendgridProvider: InboundProvider = {
  id: "SENDGRID",

  /**
   * HTTP Basic credentials against the shared secret. The username is ignored:
   * SendGrid sends whatever is in the configured URL, and only one secret is
   * configured, so the password is the whole of the credential. Missing or
   * malformed credentials are a 401, the same as a wrong password.
   */
  verify({ headers }) {
    const authorization = headers["authorization"];
    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    if (!header) return false;

    const [scheme, encoded] = header.split(" ");
    if (scheme?.toLowerCase() !== "basic" || !encoded) return false;

    let decoded: string;
    try {
      decoded = Buffer.from(encoded, "base64").toString("utf8");
    } catch {
      return false;
    }

    // Everything after the first colon: a password may legitimately contain one.
    const separator = decoded.indexOf(":");
    if (separator === -1) return false;

    return constantTimeEquals(decoded.slice(separator + 1), env.inboundEmail.secret);
  },

  parse({ fields, attachments }): InboundEmail | null {
    // SendGrid promotes very little, so the threading headers have to come out
    // of the raw `headers` blob - the full RFC 822 header block as one string.
    const headers = parseHeaderBlock(field(fields, "headers"));

    const from = parseAddress(field(fields, "from") ?? headers["from"]);
    if (!from) return null;

    const body = field(fields, "text") ?? "";

    return {
      rfcMessageId: parseMessageId(headers["message-id"]),
      from,
      recipient: pickRecipient(field(fields, "to") ?? headers["to"]),
      subject:
        truncate((field(fields, "subject") ?? headers["subject"] ?? "").trim(), MAX_SUBJECT_LENGTH) ||
        NO_SUBJECT,
      body: truncate(body, MAX_BODY_LENGTH),
      // SendGrid does no quote stripping of its own, so this is the one path
      // where `strip-quoted-reply.ts` is doing the whole job.
      strippedBody: truncate(stripQuotedReply(body), MAX_BODY_LENGTH),
      bodyHtml: field(fields, "html"),
      inReplyTo: parseMessageId(headers["in-reply-to"]),
      references: parseMessageIds(headers["references"]),
      headers,
      attachments,
      autoReply: detectAutoReply(headers, from.email),
    };
  },
};

/**
 * Parses SendGrid's `headers` field - the message's whole RFC 822 header block
 * as one string - into a lowercased map.
 *
 * Folded headers are unfolded first: RFC 5322 lets a long value continue on
 * following lines indented with whitespace, which is exactly what a References
 * header on a long thread does. Reading them line by line would find only the
 * first id and quietly break threading on the threads that need it most.
 *
 * A repeated header keeps the first value, which is what a mail reader does -
 * a second injected `Subject:` further down does not override the real one.
 */
function parseHeaderBlock(block: string | undefined): Record<string, string> {
  if (!block) return {};

  const headers: Record<string, string> = {};
  // Join a continuation line onto the one it belongs to, then split.
  const lines = block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);

  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;

    const name = line.slice(0, separator).trim().toLowerCase();
    if (name === "" || Object.hasOwn(headers, name)) continue;
    headers[name] = line.slice(separator + 1).trim();
  }

  return headers;
}
