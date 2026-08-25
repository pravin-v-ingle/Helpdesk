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

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: optionalNumber("PORT", 3000),
} as const;

export const isProduction = env.nodeEnv === "production";

// Referenced so the helper is used once the first real secret is added.
export { required };
