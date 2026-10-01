/**
 * Posts a signed, provider-shaped payload to the inbound email webhook, so the
 * whole path - verify, decode, parse, dedupe, convert - can be exercised
 * locally without a provider account, a domain or a tunnel.
 *
 *   bun run email:test [--provider mailgun|sendgrid] [--from ada@example.com]
 *                      [--subject "..."] [--body "..."]
 *                      [--message-id "<x@mail>"] [--in-reply-to "<y@mail>"]
 *                      [--header "Precedence: bulk"] [--no-message-id]
 *
 * The API must already be running (`bun run dev`). The signature is computed
 * with `INBOUND_EMAIL_SECRET`, which outside production has a fixed default -
 * so with no configuration at all this works against `bun run dev`.
 *
 * `--message-id` and `--in-reply-to` are what make the interesting cases
 * testable: send one message, then send another quoting the first's id and the
 * reply threads onto the same ticket instead of opening a second. Re-running an
 * identical command is the duplicate case.
 */
import { createHmac, randomBytes } from "node:crypto";
import { env } from "../src/env.ts";

const args = parseArgs(process.argv.slice(2));

const provider = args.provider ?? env.inboundEmail.provider;
if (provider !== "mailgun" && provider !== "sendgrid") {
  console.error(`--provider must be mailgun or sendgrid, got: ${provider}`);
  process.exit(1);
}

const from = args.from ?? "ada@example.com";
const fromName = args["from-name"] ?? "Ada Lovelace";
const recipient = args.to ?? env.supportEmailAddress ?? "support@helpdesk.example.com";
const subject = args.subject ?? "Help with my enrolment";
const body =
  args.body ??
  "Hello,\n\nI cannot see my enrolment for next term. Could you check?\n\nThanks,\nAda";

// A Message-ID unless one was given, or `--no-message-id` asked for none -
// which is how the fingerprint fallback gets exercised.
const messageId =
  "no-message-id" in args
    ? undefined
    : (args["message-id"] ?? `<${randomBytes(8).toString("hex")}@example.com>`);
const inReplyTo = args["in-reply-to"];

/** Extra raw headers, repeatable: `--header "Precedence: bulk"`. */
const extraHeaders = args._headers;

const url = `http://localhost:${env.port}/api/email/inbound`;
const form = new FormData();
const init: RequestInit = { method: "POST", body: form };

if (provider === "mailgun") {
  // Mailgun signs `timestamp + token` with the signing key, and sends all
  // three as ordinary form fields.
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const token = randomBytes(16).toString("hex");
  const signature = createHmac("sha256", env.inboundEmail.secret)
    .update(timestamp + token)
    .digest("hex");

  form.set("timestamp", timestamp);
  form.set("token", token);
  form.set("signature", signature);

  form.set("sender", from);
  form.set("from", `${fromName} <${from}>`);
  form.set("recipient", recipient);
  form.set("subject", subject);
  form.set("body-plain", body);

  const headerPairs: [string, string][] = [
    ["From", `${fromName} <${from}>`],
    ["To", recipient],
    ["Subject", subject],
    ...(messageId ? ([["Message-Id", messageId]] as [string, string][]) : []),
    ...(inReplyTo ? ([["In-Reply-To", inReplyTo]] as [string, string][]) : []),
    ...(inReplyTo ? ([["References", inReplyTo]] as [string, string][]) : []),
    ...extraHeaders,
  ];
  form.set("message-headers", JSON.stringify(headerPairs));
} else {
  // SendGrid Inbound Parse has no signature; the secret travels as HTTP Basic
  // credentials in the parse URL. The username is ignored by the adapter.
  const credentials = Buffer.from(`helpdesk:${env.inboundEmail.secret}`).toString("base64");
  init.headers = { authorization: `Basic ${credentials}` };

  form.set("from", `${fromName} <${from}>`);
  form.set("to", recipient);
  form.set("subject", subject);
  form.set("text", body);

  // SendGrid hands the whole header block over as one string, so the threading
  // headers have to be written into it rather than sent as fields.
  const lines = [
    `From: ${fromName} <${from}>`,
    `To: ${recipient}`,
    `Subject: ${subject}`,
    ...(messageId ? [`Message-ID: ${messageId}`] : []),
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
    ...extraHeaders.map(([name, value]) => `${name}: ${value}`),
  ];
  form.set("headers", lines.join("\r\n"));
}

console.log(`POST ${url}`);
console.log(`  provider     ${provider}`);
console.log(`  from         ${fromName} <${from}>`);
console.log(`  to           ${recipient}`);
console.log(`  subject      ${subject}`);
if (messageId) console.log(`  message-id   ${messageId}`);
if (inReplyTo) console.log(`  in-reply-to  ${inReplyTo}`);
for (const [name, value] of extraHeaders) console.log(`  ${name}: ${value}`);

let response: Response;
try {
  response = await fetch(url, init);
} catch (err) {
  console.error(
    `\nCould not reach ${url}. Is the API running? (bun run dev)\n${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

const text = await response.text();
console.log(`\n${response.status} ${response.statusText}`);
console.log(text);

if (!response.ok) process.exit(1);

// The Message-ID is what the next invocation needs for `--in-reply-to`, so it
// is printed as a ready-made command rather than left to be copied out by hand.
if (messageId) {
  console.log(`\nReply to this message with:\n  bun run email:test --in-reply-to "${messageId}"`);
}

/**
 * `--key value` and bare `--flag`, plus `--header "Name: value"` collected
 * separately because it repeats. Deliberately minimal: this is a development
 * script, and a real argument parser would be more code than the script.
 */
function parseArgs(argv: string[]): Record<string, string> & { _headers: [string, string][] } {
  const parsed = { _headers: [] as [string, string][] } as Record<string, string> & {
    _headers: [string, string][];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;

    const key = arg.slice(2);
    const next = argv[i + 1];
    const value = next !== undefined && !next.startsWith("--") ? next : "";
    if (value !== "") i++;

    if (key === "header") {
      const separator = value.indexOf(":");
      if (separator <= 0) {
        console.error(`--header must be "Name: value", got: ${value}`);
        process.exit(1);
      }
      parsed._headers.push([value.slice(0, separator).trim(), value.slice(separator + 1).trim()]);
      continue;
    }

    parsed[key] = value;
  }

  return parsed;
}
