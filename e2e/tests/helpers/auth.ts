import { expect, type Page } from "@playwright/test";

/** The login form's controls, resolved through the real labels and roles. */
export function loginForm(page: Page) {
  return {
    email: page.getByLabel("Email"),
    password: page.getByLabel("Password"),
    // Reads "Signing in…" while the request is in flight; `exact` keeps the
    // locator from also matching the card title.
    submit: page.getByRole("button", { name: "Sign in", exact: true }),
    // The form-level error (`errors.root`) and the field errors all render
    // with role="alert", so callers filter by text.
    alerts: page.getByRole("alert"),
  };
}

/**
 * Fills the login form and submits it. Does not wait for the outcome, so it
 * serves both the success and the refused cases.
 */
export async function submitLogin(page: Page, email: string, password: string) {
  const form = loginForm(page);
  await form.email.fill(email);
  await form.password.fill(password);
  await form.submit.click();
}

/**
 * Signs in through the UI and waits to leave the login page. `expectedPath` is
 * where the app should land afterwards - `/` unless the user was bounced from
 * somewhere else first.
 */
export async function signIn(
  page: Page,
  email: string,
  password: string,
  expectedPath = "/",
) {
  if (!page.url().includes("/login")) await page.goto("/login");
  await submitLogin(page, email, password);
  await expect(page).toHaveURL(expectedPath);
}

/** Clicks the nav bar's sign-out button and waits for the login page. */
export async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/login");
}
