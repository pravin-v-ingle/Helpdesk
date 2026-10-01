/**
 * Posting provider-shaped mail at `POST /api/email/inbound`.
 *
 * The webhook has no session: the provider's signature *is* its authentication,
 * so a spec that wants a ticket to exist has to sign a payload itself. The
 * shape mirrors `server/scripts/send-test-email.ts` (the Mailgun branch) field
 * for field, including `message-headers` - the JSON `[name, value]` array where
 * `Message-Id`, `In-Reply-To` and `References` live, and therefore where
 * threading and deduplication get their inputs.
 *
 * Everything here goes through the `request` fixture against the client origin
 * (5174), so the Vite proxy and the `Origin` header behave as they do for a
 * real caller.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { expect, type APIRequestContext, type APIResponse } from "@playwright/test";
import { inboundEmail } from "./env.ts";

/** The path the provider posts to. Relative, so `baseURL` (5174) applies. */
const INBOUND_PATH = "/api/email/inbound";

/** What `POST /api/email/inbound` answers with - `IngestResult` on the server. */
export type IngestResult = {
  rawEmailId: number;
  /** Null when the payload was stored on purpose but not turned into a ticket. */
  ticketId: number | null;
  duplicate: boolean;
};

/** One email to send, in the terms a spec cares about rather than Mailgun's. */
export type InboundMessage = {
  /** The sender's address. Lower-cased by the server's parser. */
  from: string;
  fromName: string;
  subject: string;
  body: string;
  /**
   * The RFC Message-ID, angle brackets included. Also the dedupe key, so
   * `uniqueMessageId()` is what keeps one spec's mail out of another's.
   *
   * Optional because mail without one is legal, and the fallback it triggers -
   * a fingerprint of the parsed fields - is worth testing. Omit it only with a
   * subject unique to the test: the fingerprint covers sender, recipient,
   * subject and body, so two specs sharing those would dedupe into one ticket.
   */
  messageId?: string;
  /** The Message-ID this is a reply to; sent as both In-Reply-To and References. */
  inReplyTo?: string;
  /** Extra raw headers, e.g. `["Precedence", "bulk"]` for an auto-reply. */
  headers?: [string, string][];
  /**
   * When the payload was signed, in milliseconds since the epoch. Defaults to
   * now. The signature covers the timestamp, so a payload dated outside the
   * adapter's freshness window is correctly signed and still refused - which is
   * what stops a captured payload being replayed forever.
   */
  signedAt?: number;
};

/** The decoded form fields of a Mailgun payload: what gets posted, and resent. */
export type MailgunPayload = Record<string, string>;

/**
 * A Message-ID no other test can produce. The webhook deduplicates on this
 * value, so two specs sharing one would silently become one thread.
 */
export function uniqueMessageId(label: string): string {
  return `<${label}-${Date.now()}-${randomUUID()}@example.com>`;
}

/** A subject unique to this call, so a spec can find its own ticket in the list. */
export function uniqueSubject(label: string): string {
  return `${label} ${Date.now()}-${randomBytes(3).toString("hex")}`;
}

/**
 * Builds a signed Mailgun payload. The signature is
 * `HMAC-SHA256(INBOUND_EMAIL_SECRET, timestamp + token)` over a timestamp in
 * seconds, which the adapter also checks for freshness.
 *
 * Returned rather than posted so a spec can post the *same* fields twice (the
 * replay case) or alter one before posting (the tampered-signature case).
 */
export function buildMailgunPayload(message: InboundMessage): MailgunPayload {
  const timestamp = Math.floor((message.signedAt ?? Date.now()) / 1000).toString();
  const token = randomBytes(16).toString("hex");
  const signature = createHmac("sha256", inboundEmail.secret)
    .update(timestamp + token)
    .digest("hex");

  const fromHeader = `${message.fromName} <${message.from}>`;
  const recipient = inboundEmail.supportAddress;

  const headerPairs: [string, string][] = [
    ["From", fromHeader],
    ["To", recipient],
    ["Subject", message.subject],
    ...(message.messageId ? ([["Message-Id", message.messageId]] as [string, string][]) : []),
    ...(message.inReplyTo
      ? ([
          ["In-Reply-To", message.inReplyTo],
          ["References", message.inReplyTo],
        ] as [string, string][])
      : []),
    ...(message.headers ?? []),
  ];

  return {
    timestamp,
    token,
    signature,
    sender: message.from,
    from: fromHeader,
    recipient,
    subject: message.subject,
    "body-plain": message.body,
    "message-headers": JSON.stringify(headerPairs),
  };
}

/**
 * Posts payload fields as `multipart/form-data`, the encoding Mailgun uses and
 * the one the route's `express.raw()` keeps intact for the signature check.
 * Returns the raw response: callers assert the status themselves, because a 401
 * is the expected answer in one of the tests.
 */
export function postInboundEmail(
  request: APIRequestContext,
  payload: MailgunPayload,
): Promise<APIResponse> {
  return request.post(INBOUND_PATH, { multipart: payload });
}

/**
 * Sends one email and asserts the webhook accepted it, returning both the
 * payload (so it can be replayed) and the result (for the ticket id).
 */
export async function sendInboundEmail(
  request: APIRequestContext,
  message: InboundMessage,
): Promise<{ payload: MailgunPayload; result: IngestResult }> {
  const payload = buildMailgunPayload(message);
  const res = await postInboundEmail(request, payload);
  expect(res.status(), await res.text()).toBe(200);
  return { payload, result: (await res.json()) as IngestResult };
}

/**
 * How old a signed Mailgun payload may be. Mirrors `MAX_SIGNATURE_AGE_MS` in
 * `server/src/lib/email/mailgun.ts`: the signature covers the timestamp but
 * never expires on its own, so the window is what makes a captured payload
 * unusable later.
 */
export const MAX_SIGNATURE_AGE_MS = 15 * 60 * 1000;

/**
 * Posts a body of the caller's choosing with a content type of its choosing, so
 * a spec can send something the form decoder cannot read. The content type is
 * set explicitly because Playwright would otherwise label a string body
 * `text/plain`, and the realistic failure is a multipart content type whose
 * boundary does not appear in the body.
 */
export function postRawInboundBody(
  request: APIRequestContext,
  body: string,
  contentType: string,
): Promise<APIResponse> {
  return request.post(INBOUND_PATH, { headers: { "content-type": contentType }, data: body });
}
