import { test, expect } from "@playwright/test";
import { signIn, signOut } from "./helpers/auth.ts";
import { ANONYMOUS_STORAGE_STATE, seededAdmin } from "./helpers/env.ts";

test.describe("Sign out", () => {
  // Signing out deletes the Session row, so these tests must not use the
  // shared admin storage state or they would kill the session every other
  // spec relies on.
  test.use({ storageState: ANONYMOUS_STORAGE_STATE });

  test.beforeEach(async ({ page }) => {
    await signIn(page, seededAdmin.email, seededAdmin.password);
  });

  test("returns to the login page", async ({ page }) => {
    await signOut(page);

    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByRole("banner")).toHaveCount(0);
  });

  test("protected pages redirect to /login afterwards", async ({ page }) => {
    await signOut(page);

    await page.goto("/");
    await expect(page).toHaveURL("/login");

    await page.goto("/users");
    await expect(page).toHaveURL("/login");
  });

  test("the session no longer authenticates API requests", async ({ page }) => {
    // Same cookie jar as the page, so this is the session being signed out.
    const before = await page.request.get("/api/me");
    expect(before.status()).toBe(200);

    await signOut(page);

    const after = await page.request.get("/api/me");
    expect(after.status()).toBe(401);
    expect(await after.json()).toEqual({ error: "Not authenticated" });
  });

  test("a stale tab is signed out on its next load", async ({ page, context }) => {
    const other = await context.newPage();
    await other.goto("/");
    await expect(
      other.getByRole("heading", { name: `Welcome, ${seededAdmin.name}` }),
    ).toBeVisible();

    await signOut(page);

    // The other tab still holds its rendered state; a reload asks the server
    // again, and the session row is gone.
    await other.reload();
    await expect(other).toHaveURL("/login");
    await other.close();
  });

  test("can sign back in after signing out", async ({ page }) => {
    await signOut(page);
    await signIn(page, seededAdmin.email, seededAdmin.password);

    await expect(
      page.getByRole("banner").getByText(seededAdmin.name, { exact: true }),
    ).toBeVisible();
  });
});
