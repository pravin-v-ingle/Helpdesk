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

const port = optionalNumber("PORT", 3000);

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port,
  databaseUrl: required("DATABASE_URL"),
  /** Signing secret for Better Auth session cookies. */
  betterAuthSecret: required("BETTER_AUTH_SECRET"),
  /** Public origin the auth endpoints are served from. */
  betterAuthUrl: process.env.BETTER_AUTH_URL ?? `http://localhost:${port}`,
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
