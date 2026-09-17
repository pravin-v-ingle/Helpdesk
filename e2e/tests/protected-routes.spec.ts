import { test, expect } from "@playwright/test";
import { submitLogin } from "./helpers/auth.ts";
import { ANONYMOUS_STORAGE_STATE, seededAdmin } from "./helpers/env.ts";

test.describe("Protected routes without a session", () => {
  test.use({ storageState: ANONYMOUS_STORAGE_STATE });

  test("sends an anonymous visitor from / to /login", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveURL("/login");
    await expect(page.getByLabel("Email")).toBeVisible();
  });

  test("sends an anonymous visitor from /users to /login", async ({ page }) => {
    await page.goto("/users");

    await expect(page).toHaveURL("/login");
  });

  test("returns to the page the visitor was turned away from after sign-in", async ({
    page,
  }) => {
    await page.goto("/users");
    await expect(page).toHaveURL("/login");

    await submitLogin(page, seededAdmin.email, seededAdmin.password);

    await expect(page).toHaveURL("/users");
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  });

  test("sends an unknown path to /login via the home page", async ({ page }) => {
    await page.goto("/does-not-exist");

    await expect(page).toHaveURL("/login");
  });

  test("does not reveal protected content while anonymous", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveURL("/login");
    await expect(page.getByRole("banner")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  });
});

test.describe("Protected routes with a session", () => {
  // Uses the project's admin storage state.
  test("shows the home page", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveURL("/");
    await expect(
      page.getByRole("heading", { name: `Welcome, ${seededAdmin.name}` }),
    ).toBeVisible();
  });

  test("sends an unknown path to the home page", async ({ page }) => {
    await page.goto("/does-not-exist");

    await expect(page).toHaveURL("/");
    await expect(
      page.getByRole("heading", { name: `Welcome, ${seededAdmin.name}` }),
    ).toBeVisible();
  });

  test("keeps the session across a full page reload", async ({ page }) => {
    await page.goto("/users");
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();

    await page.reload();

    // AuthProvider restores the user from GET /api/me; the page must not
    // fall back to /login in the meantime.
    await expect(page).toHaveURL("/users");
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
    await expect(
      page.getByRole("banner").getByText(seededAdmin.name, { exact: true }),
    ).toBeVisible();
  });

  test("restores the session in a brand-new tab", async ({ context }) => {
    const other = await context.newPage();
    await other.goto("/");

    await expect(other).toHaveURL("/");
    await expect(
      other.getByRole("heading", { name: `Welcome, ${seededAdmin.name}` }),
    ).toBeVisible();
    await other.close();
  });
});

test.describe("401 handling", () => {
  test("redirects to /login when the session cookie disappears", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: `Welcome, ${seededAdmin.name}` }),
    ).toBeVisible();

    // Simulates an expired or deleted session: GET /api/me now answers 401.
    await context.clearCookies();
    await page.reload();

    await expect(page).toHaveURL("/login");
    await expect(page.getByLabel("Email")).toBeVisible();
  });
});
