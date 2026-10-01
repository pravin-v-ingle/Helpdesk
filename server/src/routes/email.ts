import express, { Router } from "express";
import { inboundProvider } from "../lib/email/providers.ts";
import { decodeFormBody } from "../lib/email/multipart.ts";
import { HttpError } from "../middleware/error-handler.ts";
import { ingestInboundEmail } from "../services/inbound-email.ts";

/**
 * The inbound email webhook. The provider POSTs here when mail arrives at the
 * support address; the result is a ticket.
 *
 * There is no `requireAuth`: the provider has no session and never will. The
 * adapter's `verify()` *is* this endpoint's authentication - a Mailgun HMAC, or
 * SendGrid's HTTP Basic password - and a failure is a 401 with nothing written.
 * Rate limiting is task 8.3.
 *
 * The status codes matter more here than on a normal route, because the caller
 * is a machine that reads them as instructions:
 *
 * | Status | When                                         | Provider does   |
 * |--------|----------------------------------------------|-----------------|
 * | 401    | signature, credentials or freshness failed   | stops retrying  |
 * | 400    | body undecodable                             | stops retrying  |
 * | 413    | body over the size limit                     | stops retrying  |
 * | 200    | stored, converted or deliberately not        | done            |
 * | 500    | unexpected conversion failure                | retries         |
 *
 * A 500 is the only one that asks for a retry, and it is safe to: the payload
 * is already stored with `processedAt` null, so the retry resumes from that row
 * rather than starting a second ticket.
 */
export const inboundEmailRouter: Router = Router();

/**
 * 30 MB clears SendGrid's own ceiling; Mailgun's is 25 MB. A larger body is a
 * 413 rather than a 500 - see the error handler's body-parser branch - because
 * a provider told to retry would resend a message that can never fit, for hours.
 *
 * Every content type is accepted because both providers post
 * `multipart/form-data` and Mailgun may use `application/x-www-form-urlencoded`
 * for a small message. The raw bytes are kept rather than parsed: Mailgun's
 * signature is computed over fields of the form itself, and `express.json()`
 * would have consumed the stream before any of this ran - which is why the
 * router is mounted above it in `app.ts`.
 */
const rawBody = express.raw({ type: "*/*", limit: "30mb" });

inboundEmailRouter.post("/inbound", rawBody, async (req, res) => {
  const provider = inboundProvider();

  // Decode before verifying: Mailgun signs form *fields*, so there is nothing
  // to verify until the form is decoded. An undecodable body is a 400 and is
  // not stored - there is nothing in it to recover.
  let decoded;
  try {
    decoded = await decodeFormBody(
      Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      req.headers["content-type"],
    );
  } catch (err) {
    throw new HttpError(400, `Could not decode the request body: ${message(err)}`);
  }

  const ctx = {
    body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    headers: req.headers,
    fields: decoded.fields,
    attachments: decoded.attachments,
  };

  if (!provider.verify(ctx)) {
    // Deliberately says nothing about which part failed. The caller is either
    // the provider, which does not need to know, or someone probing.
    throw new HttpError(401, "Invalid webhook signature");
  }

  // `null` here means authentic but unusable. The service stores it anyway,
  // with an error, which is the whole reason `RawEmail` exists.
  const email = provider.parse(ctx);

  // What is stored: the decoded fields and the attachment metadata, not the raw
  // multipart bytes. Attachment *contents* are dropped - there is nowhere to put
  // a blob yet - so this is a deliberate narrowing of task 4.3's "as received".
  const result = await ingestInboundEmail(provider.id, email, {
    fields: decoded.fields,
    attachments: decoded.attachments,
  });

  res.json(result);
});

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
