import { defineConfig, devices } from "@playwright/test";
import { ADMIN_STORAGE_STATE } from "./tests/helpers/env.ts";

/**
 * End-to-end tests against the real client and API.
 *
 * The stack under test runs on its own ports (API 3001, client 5174) against
 * the `helpdesk_test` database, so the development servers on 3000/5173 and
 * the `helpdesk` database are never touched. Configuration for the test API
 * comes from `server/.env.test` (committed) and `server/.env.test.local`
 * (gitignored, holds the real DATABASE_URL); Bun loads both when NODE_ENV=test.
 *
 * The API's `start:test` script resets and seeds the test database before
 * listening, so every run starts from a clean schema with the test admin in
 * place. That reset has to live in the server command rather than in
 * `globalSetup`, because Playwright starts `webServer` first.
 *
 * Projects: `setup` signs the seeded admin in once and saves the browser
 * storage state; `chromium` depends on it and starts every test with that
 * state, so most specs begin already signed in as the admin. Specs that need
 * an anonymous browser (login, redirects) opt out with
 * `test.use({ storageState: ANONYMOUS_STORAGE_STATE })`.
 */

const API_PORT = 3001;
const CLIENT_PORT = 5174;

export default defineConfig({
  testDir: "./tests",
  // Tests share one seeded database; revisit once there are tests that could
  // safely run side by side.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "html",

  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    trace: "on-first-retry",
  },

  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: ADMIN_STORAGE_STATE },
      dependencies: ["setup"],
    },
  ],

  webServer: [
    {
      name: "API",
      command: "bun run start:test",
      cwd: "../server",
      url: `http://localhost:${API_PORT}/api/health`,
      env: { NODE_ENV: "test" },
      // Never reuse: a fresh process is what guarantees the database reset ran.
      reuseExistingServer: false,
      // Show the reset and migrate output.
      stdout: "pipe",
      timeout: 120_000,
    },
    {
      name: "Client",
      command: "bun run dev:test",
      cwd: "../client",
      url: `http://localhost:${CLIENT_PORT}`,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
