import { test, expect } from "@playwright/test";
import { loginForm, submitLogin } from "./helpers/auth.ts";
import { ANONYMOUS_STORAGE_STATE, seededAdmin } from "./helpers/env.ts";

// Better Auth's message for both an unknown email and a wrong password - the
// same text on purpose, so the form does not reveal which addresses exist.
const INVALID_CREDENTIALS = "Invalid email or password";

test.describe("Login page", () => {
  // These tests start with no session; the project default is the admin's.
  test.use({ storageState: ANONYMOUS_STORAGE_STATE });

  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
  });

  test("renders the sign-in form", async ({ page }) => {
    // CardTitle renders a <div>, not a heading, so the title is found by its
    // shadcn slot rather than getByRole("heading").
    await expect(page.locator('[data-slot="card-title"]')).toHaveText("Sign in");
    await expect(page.getByText("Helpdesk agent and admin access.")).toBeVisible();

    const form = loginForm(page);
    await expect(form.email).toBeVisible();
    await expect(form.email).toHaveAttribute("type", "email");
    await expect(form.password).toBeVisible();
    await expect(form.password).toHaveAttribute("type", "password");
    await expect(form.submit).toBeVisible();
    await expect(form.submit).toBeEnabled();
  });

  test.describe("client-side validation", () => {
    // Every test here must stay on /login without calling the API.
    let signInRequests: number;

    test.beforeEach(({ page }) => {
      signInRequests = 0;
      page.on("request", (request) => {
        if (request.url().includes("/api/auth/sign-in")) signInRequests += 1;
      });
    });

    test("requires an email and a password", async ({ page }) => {
      await loginForm(page).submit.click();

      await expect(page.getByText("Enter your email address.")).toBeVisible();
      await expect(page.getByText("Enter your password.")).toBeVisible();
      await expect(loginForm(page).email).toHaveAttribute("aria-invalid", "true");
      await expect(loginForm(page).password).toHaveAttribute("aria-invalid", "true");
      await expect(page).toHaveURL("/login");
      expect(signInRequests).toBe(0);
    });

    test("rejects a malformed email address", async ({ page }) => {
      await submitLogin(page, "not-an-email", "some-password");

      await expect(page.getByText("Enter a valid email address.")).toBeVisible();
      // The blank-field message short-circuits the format check, so only the
      // format message is shown, and the password field is fine.
      await expect(page.getByText("Enter your email address.")).toHaveCount(0);
      await expect(page.getByText("Enter your password.")).toHaveCount(0);
      await expect(page).toHaveURL("/login");
      expect(signInRequests).toBe(0);
    });

    test("treats a whitespace-only email as empty", async ({ page }) => {
      await submitLogin(page, "   ", "some-password");

      await expect(page.getByText("Enter your email address.")).toBeVisible();
      await expect(page).toHaveURL("/login");
      expect(signInRequests).toBe(0);
    });
  });

  test.describe("refused by the server", () => {
    test("rejects a wrong password for a real account", async ({ page }) => {
      await submitLogin(page, seededAdmin.email, "definitely-not-the-password");

      await expect(
        page.getByRole("alert").filter({ hasText: INVALID_CREDENTIALS }),
      ).toBeVisible();
      await expect(page).toHaveURL("/login");
      // No field-level errors: the credentials were well-formed.
      await expect(page.getByText("Enter your email address.")).toHaveCount(0);
    });

    test("rejects an email that has no account", async ({ page }) => {
      await submitLogin(page, `nobody-${Date.now()}@test.local`, "some-password-123");

      await expect(
        page.getByRole("alert").filter({ hasText: INVALID_CREDENTIALS }),
      ).toBeVisible();
      await expect(page).toHaveURL("/login");
    });

    test("clears the previous error on the next attempt", async ({ page }) => {
      await submitLogin(page, seededAdmin.email, "wrong-password");
      await expect(
        page.getByRole("alert").filter({ hasText: INVALID_CREDENTIALS }),
      ).toBeVisible();

      await loginForm(page).password.fill(seededAdmin.password);
      await loginForm(page).submit.click();

      await expect(page).toHaveURL("/");
      await expect(
        page.getByRole("alert").filter({ hasText: INVALID_CREDENTIALS }),
      ).toHaveCount(0);
    });
  });

  test.describe("successful sign-in", () => {
    test("lands on the home page and shows the signed-in admin", async ({ page }) => {
      await submitLogin(page, seededAdmin.email, seededAdmin.password);

      await expect(page).toHaveURL("/");
      const nav = page.getByRole("banner");
      await expect(nav.getByText(seededAdmin.name, { exact: true })).toBeVisible();
      await expect(nav.getByText("Admin", { exact: true })).toBeVisible();
      await expect(nav.getByRole("button", { name: "Sign out" })).toBeVisible();
      await expect(
        page.getByRole("heading", { name: `Welcome, ${seededAdmin.name}` }),
      ).toBeVisible();
      await expect(
        page.getByText(`You are signed in as ${seededAdmin.email} with the admin role.`),
      ).toBeVisible();
    });

    test("accepts the email with different casing and surrounding spaces", async ({ page }) => {
      await submitLogin(page, `  ${seededAdmin.email.toUpperCase()}  `, seededAdmin.password);

      await expect(page).toHaveURL("/");
      await expect(
        page.getByRole("banner").getByText(seededAdmin.name, { exact: true }),
      ).toBeVisible();
    });

    test("disables the submit button while the request is in flight", async ({ page }) => {
      // Hold the sign-in response so the submitting state can be observed
      // deterministically rather than raced against a fast server.
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/api/auth/sign-in/email", async (route) => {
        await held;
        await route.continue();
      });

      await submitLogin(page, seededAdmin.email, seededAdmin.password);

      const submitting = page.getByRole("button", { name: "Signing in…" });
      await expect(submitting).toBeVisible();
      await expect(submitting).toBeDisabled();
      await expect(page).toHaveURL("/login");

      release();
      await expect(page).toHaveURL("/");
    });
  });
});

test.describe("Login page when already signed in", () => {
  // Uses the project's admin storage state.
  test("redirects to the home page instead of showing the form", async ({ page }) => {
    await page.goto("/login");

    await expect(page).toHaveURL("/");
    await expect(
      page.getByRole("heading", { name: `Welcome, ${seededAdmin.name}` }),
    ).toBeVisible();
    await expect(page.getByLabel("Email")).toHaveCount(0);
  });
});
