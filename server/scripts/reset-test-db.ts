/**
 * Resets the end-to-end test database to a clean, seeded state.
 *
 *   NODE_ENV=test bun run db:test:reset
 *
 * Run by `start:test` before the API listens, so every Playwright run begins
 * from the same place: all migrations applied to an empty schema and the test
 * admin from SEED_ADMIN_* in `.env.test` present.
 *
 * This drops every table, so it refuses to run unless NODE_ENV is `test` and
 * the database name ends in `_test`. That guard is what keeps the development
 * database safe from a stray invocation.
 */
import { $, SQL } from "bun";
import { env } from "../src/env.ts";

const url = new URL(env.databaseUrl);
const database = decodeURIComponent(url.pathname.replace(/^\//, ""));

if (env.nodeEnv !== "test") {
  console.error(
    `Refusing to reset: NODE_ENV is "${env.nodeEnv}", not "test".`,
  );
  process.exit(1);
}

if (!database.endsWith("_test")) {
  console.error(
    `Refusing to reset "${database}": the test database name must end in "_test".\n` +
      "Check DATABASE_URL in server/.env.test.local.",
  );
  process.exit(1);
}

// `prisma migrate reset` needs the database to exist. Create it on first run
// through the `postgres` maintenance database on the same server and
// credentials.
const maintenanceUrl = new URL(url);
maintenanceUrl.pathname = "/postgres";
maintenanceUrl.search = "";

const sql = new SQL(maintenanceUrl.toString());
try {
  const [existing] = await sql`SELECT 1 FROM pg_database WHERE datname = ${database}`;
  if (!existing) {
    // Identifiers cannot be parameterised; the name passed the `_test` check
    // above and is quoted here with any embedded quotes doubled.
    await sql.unsafe(`CREATE DATABASE "${database.replaceAll('"', '""')}"`);
    console.log(`Created database ${database}.`);
  }
} finally {
  await sql.close();
}

console.log(`Resetting ${database}...`);
// Both inherit this process's environment, so they see the same test
// DATABASE_URL. `--force` skips the interactive confirmation.
await $`bun run prisma migrate reset --force`;
await $`bun prisma/seed.ts`;
console.log(`Reset ${database}: migrations applied, test admin seeded.`);
