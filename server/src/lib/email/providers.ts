/**
 * The adapter registry: which provider's code handles an inbound payload.
 *
 * Separate from `inbound-email.ts` on purpose. That module holds the types and
 * the helpers every adapter needs, so every adapter imports it; if it imported
 * the adapters back to build this registry, the cycle would break the moment an
 * adapter was the first module loaded - `PROVIDERS` would be evaluated while
 * `mailgun.ts` was still halfway through its own body, and
 * `mailgunProvider` would be in its temporal dead zone. Keeping the registry
 * downstream of both makes the graph acyclic in every entry order.
 */
import { env } from "../../env.ts";
import type { EmailProvider } from "../../generated/prisma/enums.ts";
import type { InboundProvider } from "./inbound-email.ts";
import { mailgunProvider } from "./mailgun.ts";
import { sendgridProvider } from "./sendgrid.ts";

/**
 * Every provider, keyed by the Prisma enum. A `Record` over the enum rather
 * than a lookup with a fallback: adding `EmailProvider.POSTMARK` to the schema
 * is then a compile error here until an adapter exists for it, which is the
 * point of the enum being an enum.
 */
export const PROVIDERS: Record<EmailProvider, InboundProvider> = {
  MAILGUN: mailgunProvider,
  SENDGRID: sendgridProvider,
};

/** Maps the configured provider name onto its `EmailProvider` enum member. */
const PROVIDER_IDS: Record<typeof env.inboundEmail.provider, EmailProvider> = {
  mailgun: "MAILGUN",
  sendgrid: "SENDGRID",
};

/** The adapter `INBOUND_EMAIL_PROVIDER` selects. Validated at startup in `env.ts`. */
export function inboundProvider(): InboundProvider {
  return PROVIDERS[PROVIDER_IDS[env.inboundEmail.provider]];
}
