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
} as const;

export const isProduction = isProductionEnv;
