/**
 * Environment configuration, read and validated once at startup.
 * The process exits immediately if something required is missing or invalid,
 * rather than failing later at first use.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`Environment variable ${name} must be a positive integer, got: ${raw}`);
    process.exit(1);
  }
  return parsed;
}

/**
 * A comma-separated list of origins. Entries are trimmed, so
 * `A, B` and `A,B` are the same.
 *
 * Each entry must be a full origin such as `https://helpdesk.example.com`.
 * Wildcard patterns like `https://*.example.com` are passed through untouched,
 * because Better Auth matches them itself.
 */
function originList(name: string, fallback: string[] | undefined): string[] {
  const raw = process.env[name];
  if (raw === undefined) {
    if (fallback) return fallback;
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }

  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    console.error(`Environment variable ${name} is set but lists no origins.`);
    process.exit(1);
  }

  for (const origin of origins) {
    if (origin.includes("*")) continue;

    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      console.error(`Environment variable ${name} contains an invalid origin: ${origin}`);
      process.exit(1);
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      console.error(
        `Environment variable ${name} contains a non-HTTP origin: ${origin}`,
      );
      process.exit(1);
    }
  }

  return origins;
}

/**
 * A comma-separated list of reverse proxies, as IPs, CIDR ranges or the
 * keywords Express understands (`loopback`, `linklocal`, `uniquelocal`).
 * Empty means no proxy: the socket address is the client.
 */
function proxyList(name: string): string[] {
  const raw = process.env[name];
  if (raw === undefined) return [];

  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    console.error(`Environment variable ${name} is set but lists no proxies.`);
    process.exit(1);
  }

  return entries;
}

/**
 * The OpenAI model the AI features ask. `gpt-5-nano` by default - the cheapest
 * and fastest of the GPT-5 family, which is the right trade for small text jobs
 * an agent reads and can discard: rewriting a draft reply, summarising a thread.
 *
 * One setting for both rather than one each. They are the same kind of work on
 * the same size of input, and a knob per feature is a knob nobody sets - if the
 * two ever want different models, that is the moment to split it.
 *
 * Overridable because a model id is the one setting here that goes stale on
 * somebody else's schedule, and a redeploy to change a string is not worth it.
 */
const DEFAULT_OPENAI_MODEL = "gpt-5-nano";

/**
 * The OpenAI API key, and nothing enforces its presence at startup.
 *
 * Every other secret here is `required()` because the server cannot do its job
 * without it; this one gates two optional buttons. A deployment with no key
 * still serves tickets, email and sign-in, and the two AI endpoints answer 503
 * with a sentence the page shows - which is a better failure than a server that
 * refuses to boot because nobody wanted the AI features.
 */
function openAiApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY?.trim() || undefined;
}

const port = optionalNumber("PORT", 3000);
const nodeEnv = process.env.NODE_ENV ?? "development";
const isProductionEnv = nodeEnv === "production";

/**
 * Better Auth derives the session cookie's `Secure` flag from this URL's
 * scheme, so a production deployment behind a TLS terminator must give the
 * public `https://` origin here - not the plain-HTTP address the proxy talks
 * to - or the cookie goes out without `Secure`. Outside production it defaults
 * to the local API address.
 */
function betterAuthUrl(): string {
  if (!isProductionEnv) return process.env.BETTER_AUTH_URL ?? `http://localhost:${port}`;

  const url = required("BETTER_AUTH_URL");
  if (!url.startsWith("https://")) {
    console.error(
      `Environment variable BETTER_AUTH_URL must be an https:// origin in production, got: ${url}`,
    );
    process.exit(1);
  }
  return url;
}

/**
 * Which provider's wire format the inbound webhook expects, and therefore
 * which adapter verifies the signature. Getting this wrong rejects every
 * inbound email with a 401, because the other provider's signature scheme
 * does not verify.
 */
const INBOUND_EMAIL_PROVIDERS = ["mailgun", "sendgrid"] as const;

export type InboundEmailProviderName = (typeof INBOUND_EMAIL_PROVIDERS)[number];

function inboundEmailProvider(): InboundEmailProviderName {
  const raw = process.env.INBOUND_EMAIL_PROVIDER;
  if (raw === undefined) return "mailgun";

  const name = raw.trim().toLowerCase();
  if (!INBOUND_EMAIL_PROVIDERS.includes(name as InboundEmailProviderName)) {
    console.error(
      `Environment variable INBOUND_EMAIL_PROVIDER must be one of ` +
        `${INBOUND_EMAIL_PROVIDERS.join(", ")}, got: ${raw}`,
    );
    process.exit(1);
  }
  return name as InboundEmailProviderName;
}

const DEV_INBOUND_EMAIL_SECRET = "dev-inbound-email-secret-not-for-production";
const MIN_INBOUND_EMAIL_SECRET_LENGTH = 32;

/**
 * The shared secret the inbound webhook authenticates with. What it means is
 * the chosen provider's business: Mailgun's HTTP webhook signing key, or the
 * password SendGrid sends as HTTP Basic credentials in the Inbound Parse URL.
 * Either way it is the *only* thing standing between the internet and ticket
 * creation, so a production deployment must set a real one - a wrong or absent
 * value there would either reject all mail or, worse, accept anyone's.
 *
 * Outside production it falls back to a fixed development value, the same
 * precedent `betterAuthUrl` follows: `bun run dev` keeps working on an
 * existing `.env`, and `bun run email:test` signs its payloads with no setup.
 */
function inboundEmailSecret(): string {
  if (!isProductionEnv) return process.env.INBOUND_EMAIL_SECRET ?? DEV_INBOUND_EMAIL_SECRET;

  const secret = required("INBOUND_EMAIL_SECRET");
  if (secret.length < MIN_INBOUND_EMAIL_SECRET_LENGTH) {
    console.error(
      `Environment variable INBOUND_EMAIL_SECRET must be at least ` +
        `${MIN_INBOUND_EMAIL_SECRET_LENGTH} characters in production.`,
    );
    process.exit(1);
  }
  return secret;
}

export const env = {
  nodeEnv,
  port,
  databaseUrl: required("DATABASE_URL"),
  /** Signing secret for Better Auth session cookies. */
  betterAuthSecret: required("BETTER_AUTH_SECRET"),
  /** Public origin the auth endpoints are served from. */
  betterAuthUrl: betterAuthUrl(),
  /**
   * Origins Better Auth accepts requests from, on top of `betterAuthUrl`, which
   * it always trusts. In development this is the Vite dev server; in production
   * it is whatever domain serves the client.
   *
   * The default only applies outside production - shipping a build that trusts
   * `localhost` would be a quiet mistake, so production must say so explicitly
   * and the process refuses to start until it does.
   */
  trustedOrigins: originList(
    "TRUSTED_ORIGINS",
    isProductionEnv ? undefined : ["http://localhost:5173"],
  ),
  /**
   * Reverse proxies whose `X-Forwarded-For` header can be believed, for
   * Express's `trust proxy` setting. The client IP Express derives from this
   * is what Better Auth's rate limiter keys on, so a wrong value here either
   * lets a client choose its own bucket (too trusting) or puts every client in
   * one shared bucket (not trusting the real proxy).
   */
  trustedProxies: proxyList("TRUSTED_PROXIES"),
  /**
   * The initial admin account, read by `prisma/seed.ts` only. Optional here
   * because the API itself does not need them - the seed script exits with its
   * own message when they are missing, rather than blocking every boot.
   */
  seedAdmin: {
    email: process.env.SEED_ADMIN_EMAIL,
    name: process.env.SEED_ADMIN_NAME,
    password: process.env.SEED_ADMIN_PASSWORD,
  },
  /** Inbound email: which provider posts to the webhook, and how it proves it. */
  inboundEmail: {
    provider: inboundEmailProvider(),
    secret: inboundEmailSecret(),
  },
  /**
   * The support mailbox mail arrives at, lowercased. Optional: nothing breaks
   * without it, but two things get less precise. Mail addressed to several
   * recipients is matched against it to pick the one that is ours, so
   * `requesterEmail` is never set from our own address; and a message whose
   * sender is this address is treated as an auto-reply, which is what stops a
   * mail loop once outbound send lands in 4.12.
   */
  supportEmailAddress: process.env.SUPPORT_EMAIL_ADDRESS?.trim().toLowerCase() || undefined,
  /**
   * The OpenAI account the AI features use - the reply polisher and the ticket
   * summariser. Optional, unlike every other secret here: see `openAiApiKey`
   * above for why, and `lib/ai.ts` for the 503 an absent key produces.
   *
   * This is the one place in the system that talks to a provider other than
   * Anthropic; `tech-stack.md` records why.
   */
  openai: {
    apiKey: openAiApiKey(),
    model: process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL,
  },
} as const;

export const isProduction = isProductionEnv;
