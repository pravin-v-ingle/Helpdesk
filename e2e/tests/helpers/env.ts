import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The seeded admin the e2e API starts with, read from `server/.env.test` so the
 * credentials are declared in exactly one place. The API loads the same file
 * under NODE_ENV=test, so what we read here is what the seed script wrote.
 */
const ENV_TEST_PATH = path.resolve(import.meta.dirname, "../../../server/.env.test");

function parseDotenv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

const testEnv = parseDotenv(readFileSync(ENV_TEST_PATH, "utf8"));

function required(key: string): string {
  const value = testEnv[key];
  if (!value) throw new Error(`${key} is not set in ${ENV_TEST_PATH}`);
  return value;
}

export const seededAdmin = {
  email: required("SEED_ADMIN_EMAIL"),
  password: required("SEED_ADMIN_PASSWORD"),
  name: testEnv["SEED_ADMIN_NAME"] ?? "Admin",
} as const;

/** Where the setup project saves the admin's signed-in storage state. */
export const ADMIN_STORAGE_STATE = path.resolve(
  import.meta.dirname,
  "../../playwright/.auth/admin.json",
);

/** A storage state with no cookies, for tests that must start anonymous. */
export const ANONYMOUS_STORAGE_STATE: { cookies: []; origins: [] } = { cookies: [], origins: [] };
