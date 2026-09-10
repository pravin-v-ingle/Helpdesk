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
function originList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined) return fallback;

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

const port = optionalNumber("PORT", 3000);
const nodeEnv = process.env.NODE_ENV ?? "development";

export const env = {
  nodeEnv,
  port,
  databaseUrl: required("DATABASE_URL"),
  /** Signing secret for Better Auth session cookies. */
  betterAuthSecret: required("BETTER_AUTH_SECRET"),
  /** Public origin the auth endpoints are served from. */
  betterAuthUrl: process.env.BETTER_AUTH_URL ?? `http://localhost:${port}`,
  /**
   * Origins Better Auth accepts requests from, on top of `betterAuthUrl`, which
   * it always trusts. In development this is the Vite dev server; in production
   * it is whatever domain serves the client.
   *
   * The default only applies outside production - shipping a build that trusts
   * `localhost` would be a quiet mistake, so production must say so explicitly.
   */
  trustedOrigins: originList(
    "TRUSTED_ORIGINS",
    nodeEnv === "production" ? [] : ["http://localhost:5173"],
  ),
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

export const isProduction = env.nodeEnv === "production";
