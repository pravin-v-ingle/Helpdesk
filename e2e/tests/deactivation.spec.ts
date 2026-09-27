import { test, expect } from "@playwright/test";
import {
  createAgent,
  deactivateUser,
  TEST_USER_PASSWORD,
  type PublicUser,
} from "./helpers/api.ts";
import { signIn, submitLogin } from "./helpers/auth.ts";
import { ANONYMOUS_STORAGE_STATE } from "./helpers/env.ts";

// Set by the `session.create.before` hook in server/src/lib/auth.ts.
const DEACTIVATED_MESSAGE = "This account has been deactivated.";

/**
 * Deactivation only - the reversible suspension written by
 * `PATCH /api/users/:id { active: false }`. Deleting a user is the other
 * removal and has its own spec (`deletion.spec.ts`); `deactivateUser` here
 * must stay on the PATCH so these tests keep covering this path.
 *
 * The `request` fixture carries the admin session (project storage state) and
 * is used to create and deactivate agents; the agent itself gets a separate
 * browser context with no cookies.
 */
test.describe("Deactivated accounts", () => {
  test("cannot sign in and see why", async ({ browser, baseURL, request }) => {
    const agent = await createAgent(request, "Deactivated Agent");
    const deactivated = await deactivateUser(request, agent.id);
    expect(deactivated.active).toBe(false);
    // Suspended, not deleted: the distinction the two states record.
    expect(deactivated.deletedAt).toBeNull();

    const context = await browser.newContext({ baseURL, storageState: ANONYMOUS_STORAGE_STATE });
    const page = await context.newPage();
    await page.goto("/login");
    await submitLogin(page, agent.email, TEST_USER_PASSWORD);

    await expect(page.getByRole("alert").filter({ hasText: DEACTIVATED_MESSAGE })).toBeVisible();
    await expect(page).toHaveURL("/login");
    // No session was created for the refused sign-in.
    expect((await context.request.get("/api/me")).status()).toBe(401);

    await context.close();
  });

  test("a live session is killed by deactivation", async ({ browser, baseURL, request }) => {
    const agent = await createAgent(request, "Signed-in Agent");

    const context = await browser.newContext({ baseURL, storageState: ANONYMOUS_STORAGE_STATE });
    const page = await context.newPage();
    await signIn(page, agent.email, TEST_USER_PASSWORD);
    await expect(page.getByRole("heading", { name: `Welcome, ${agent.name}` })).toBeVisible();
    expect((await context.request.get("/api/me")).status()).toBe(200);

    await deactivateUser(request, agent.id);

    // The Session row is gone, so the cookie the browser still holds is worthless.
    expect((await context.request.get("/api/me")).status()).toBe(401);
    await page.reload();
    await expect(page).toHaveURL("/login");

    await context.close();
  });

  test("deactivating twice is harmless", async ({ request }) => {
    const agent = await createAgent(request, "Twice Deactivated");

    const first = await deactivateUser(request, agent.id);
    const second = await deactivateUser(request, agent.id);

    expect(first.active).toBe(false);
    expect(second.active).toBe(false);
    // The no-op returns the row as it stands, and neither call is a deletion.
    expect(first.deletedAt).toBeNull();
    expect(second.deletedAt).toBeNull();
  });

  test("a reactivated account can sign in again", async ({ browser, baseURL, request }) => {
    const agent = await createAgent(request, "Reactivated Agent");
    await deactivateUser(request, agent.id);

    const res = await request.patch(`/api/users/${agent.id}`, { data: { active: true } });
    expect(res.status(), await res.text()).toBe(200);
    const restored = ((await res.json()) as { user: PublicUser }).user;
    expect(restored.active).toBe(true);
    expect(restored.deletedAt).toBeNull();

    const context = await browser.newContext({ baseURL, storageState: ANONYMOUS_STORAGE_STATE });
    const page = await context.newPage();
    await signIn(page, agent.email, TEST_USER_PASSWORD);
    await expect(page.getByRole("heading", { name: `Welcome, ${agent.name}` })).toBeVisible();

    await context.close();
  });
});
