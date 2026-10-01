/**
 * Decoding a webhook's form body. Both providers post `multipart/form-data`;
 * Mailgun can also send `application/x-www-form-urlencoded` for a small
 * message.
 *
 * No new dependency: Bun implements `FormData` and its parsers, so a `Response`
 * wrapped around the raw bytes decodes both encodings. That is why the route
 * keeps the body raw - `express.json()` would consume the stream and neither
 * encoding is JSON anyway.
 */

/** Attachment metadata. The bytes are deliberately dropped - see below. */
export type InboundAttachment = {
  filename: string;
  contentType: string;
  size: number;
};

export type DecodedFormBody = {
  /** Every non-file field. A repeated key keeps the last value, as forms do. */
  fields: Record<string, string>;
  attachments: InboundAttachment[];
};

/**
 * Parses a raw webhook body into its fields and its attachment metadata.
 *
 * Attachment *contents* are dropped on purpose: there is nowhere to put a blob
 * yet, and holding a 25 MB file in the `RawEmail.payload` JSON column would be
 * worse than not having it. The metadata is kept so a ticket can at least say
 * that something was attached.
 *
 * Throws when the body cannot be decoded - no content type, or multipart whose
 * boundary does not match its parts. The route turns that into a 400, which
 * tells the provider to stop retrying: a body that does not decode never will.
 */
export async function decodeFormBody(
  buf: Buffer,
  contentType: string | undefined,
): Promise<DecodedFormBody> {
  if (!contentType) throw new Error("the request has no Content-Type header");

  // `Response.formData()` is where the actual parsing happens. It reads the
  // boundary out of the content type, so the header has to be passed through
  // exactly as it arrived.
  const form = await new Response(buf, { headers: { "content-type": contentType } }).formData();

  const fields: Record<string, string> = {};
  const attachments: InboundAttachment[] = [];

  for (const [key, value] of form.entries()) {
    if (typeof value === "string") {
      fields[key] = value;
      continue;
    }

    attachments.push({
      filename: value.name,
      contentType: value.type || "application/octet-stream",
      size: value.size,
    });
  }

  return { fields, attachments };
}

/**
 * Looks a field up case-insensitively, first match wins over the candidates
 * given.
 *
 * Mailgun mixes its own lowercase parsed fields (`body-plain`, `sender`) with
 * raw header names in their original casing (`Message-Id`, `In-Reply-To`), and
 * the casing of the latter is the sender's choice, not Mailgun's. Matching
 * exactly would therefore work for most mail and silently fail for some.
 */
export function field(
  fields: Record<string, string>,
  ...names: string[]
): string | undefined {
  const lowered = new Map(Object.entries(fields).map(([key, value]) => [key.toLowerCase(), value]));

  for (const name of names) {
    const value = lowered.get(name.toLowerCase());
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}
