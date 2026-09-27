import { expect, type Browser, type Page } from "@playwright/test";
import { ANONYMOUS_STORAGE_STATE } from "./env.ts";

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

/**
 * A browser context with no cookies. The `chromium` project starts every test
 * with the admin's storage state, so any test that needs an anonymous browser
 * or a second, differently signed-in user needs its own cookie jar. Callers
 * close the context.
 */
export async function anonymousContext(browser: Browser, baseURL: string | undefined) {
  return browser.newContext({ baseURL, storageState: ANONYMOUS_STORAGE_STATE });
}

/**
 * A fresh context signed in through the login form as the given account, plus
 * its page. Fails the test if the credentials are refused, so a caller can read
 * it as "this password works". Callers close the context.
 */
export async function signInAs(
  browser: Browser,
  baseURL: string | undefined,
  email: string,
  password: string,
) {
  const context = await anonymousContext(browser, baseURL);
  const page = await context.newPage();
  await signIn(page, email, password);
  return { context, page };
}
