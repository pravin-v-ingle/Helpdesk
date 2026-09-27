import { test, expect, type Page } from "@playwright/test";
import {
  createAgent,
  deactivateUser,
  Role,
  signInViaApi,
  TEST_USER_PASSWORD,
  type PublicUser,
} from "./helpers/api.ts";
import { anonymousContext, signIn, signInAs, submitLogin } from "./helpers/auth.ts";

/**
 * Editing an existing user: the per-row dialog on `/users`
 * (`components/EditUserDialog.tsx` over `UserFormDialog.tsx`) and the
 * `PATCH /api/users/:id` behind it.
 *
 * Every test works on an agent it created itself, and narrows the list to that
 * agent with `?q=<email>`, so the specs stay independent of each other and of
 * whatever else the shared run has left in the database. The seeded admin is
 * never edited - the rest of the suite signs in as it.
 */

/** A password no other spec uses, long enough for Better Auth's minimum. */
const NEW_PASSWORD = "changed-password-456";

// Better Auth's message for both an unknown email and a wrong password.
const INVALID_CREDENTIALS = "Invalid email or password";
// The users service's 409, which the dialog shows against the email field.
const DUPLICATE_EMAIL = "A user with that email already exists";

/** The one row for a user; the email cell is unique per account. */
function rowFor(page: Page, email: string) {
  return page.getByRole("row").filter({ hasText: email });
}

/** Opens `/users` filtered down to a single user and waits for their row. */
async function openUsersPageFor(page: Page, user: PublicUser) {
  await page.goto(`/users?q=${encodeURIComponent(user.email)}`);
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  await expect(rowFor(page, user.email)).toBeVisible();
}

/**
 * Clicks a row's icon-only edit button - its accessible name carries the user's
 * current name - and returns the dialog's controls.
 */
async function openEditDialog(page: Page, user: { name: string; email: string }) {
  await rowFor(page, user.email)
    .getByRole("button", { name: `Edit ${user.name}` })
    .click();

  const dialog = page.getByRole("dialog", { name: "Edit user" });
  await expect(dialog).toBeVisible();

  return {
    dialog,
    name: dialog.getByLabel("Name"),
    email: dialog.getByLabel("Email"),
    password: dialog.getByLabel("Password"),
    save: dialog.getByRole("button", { name: "Save changes" }),
    cancel: dialog.getByRole("button", { name: "Cancel" }),
  };
}

test.describe("Editing a user from the users page", () => {
  // Uses the project's admin storage state.

  test("opens with the row's values and a blank password", async ({ page, request }) => {
    const agent = await createAgent(request, "Prefilled Agent");
    await openUsersPageFor(page, agent);

    const form = await openEditDialog(page, agent);

    await expect(form.dialog).toContainText("Leave the password blank to keep the current one.");
    await expect(form.name).toHaveValue(agent.name);
    await expect(form.email).toHaveValue(agent.email);
    await expect(form.password).toHaveValue("");
  });

  test("renames an agent and shows the new name in the table", async ({ page, request }) => {
    const agent = await createAgent(request, "Rename Me");
    await openUsersPageFor(page, agent);

    const form = await openEditDialog(page, agent);
    await form.name.fill("Renamed Agent");
    await form.save.click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    const row = rowFor(page, agent.email);
    await expect(row).toContainText("Renamed Agent");
    // The row's action button is named from the saved name, so the list really
    // refetched rather than only repainting the cell.
    await expect(row.getByRole("button", { name: "Edit Renamed Agent" })).toBeVisible();
  });

  test("leaves the password alone when the field is left blank", async ({
    page,
    browser,
    baseURL,
    request,
  }) => {
    const agent = await createAgent(request, "Keeps Password");
    await openUsersPageFor(page, agent);

    const form = await openEditDialog(page, agent);
    await form.name.fill("Keeps Password Still");
    await form.save.click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(rowFor(page, agent.email)).toContainText("Keeps Password Still");

    // The account still signs in with the password it was created with.
    const { context, page: agentPage } = await signInAs(
      browser,
      baseURL,
      agent.email,
      TEST_USER_PASSWORD,
    );
    await expect(
      agentPage.getByRole("heading", { name: "Welcome, Keeps Password Still" }),
    ).toBeVisible();
    await context.close();
  });

  test("replaces the password when one is typed", async ({ page, browser, baseURL, request }) => {
    const agent = await createAgent(request, "New Password Agent");
    await openUsersPageFor(page, agent);

    const form = await openEditDialog(page, agent);
    await form.password.fill(NEW_PASSWORD);
    await form.save.click();

    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The new password works...
    const { context, page: agentPage } = await signInAs(
      browser,
      baseURL,
      agent.email,
      NEW_PASSWORD,
    );
    await expect(agentPage.getByRole("heading", { name: `Welcome, ${agent.name}` })).toBeVisible();
    await context.close();

    // ...and the old one does not.
    const oldContext = await anonymousContext(browser, baseURL);
    const oldPage = await oldContext.newPage();
    await oldPage.goto("/login");
    await submitLogin(oldPage, agent.email, TEST_USER_PASSWORD);
    await expect(
      oldPage.getByRole("alert").filter({ hasText: INVALID_CREDENTIALS }),
    ).toBeVisible();
    await expect(oldPage).toHaveURL("/login");
    await oldContext.close();
  });

  test("shows a taken email under the Email field and stays open", async ({ page, request }) => {
    const other = await createAgent(request, "Owns The Email");
    const agent = await createAgent(request, "Wants The Email");
    await openUsersPageFor(page, agent);

    const form = await openEditDialog(page, agent);
    await form.email.fill(other.email);
    await form.save.click();

    await expect(form.dialog).toBeVisible();
    await expect(form.dialog.getByText(DUPLICATE_EMAIL)).toBeVisible();
    await expect(form.email).toHaveAttribute("aria-invalid", "true");

    // Nothing was saved: the row still has its own email and name.
    await form.cancel.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(rowFor(page, agent.email)).toContainText(agent.name);
  });

  test("refuses a short name and a short password without calling the API", async ({
    page,
    request,
  }) => {
    const agent = await createAgent(request, "Validated Agent");

    let patchRequests = 0;
    page.on("request", (req) => {
      if (req.method() === "PATCH" && req.url().includes("/api/users/")) patchRequests += 1;
    });

    await openUsersPageFor(page, agent);
    const form = await openEditDialog(page, agent);
    await form.name.fill("ab");
    await form.password.fill("short12"); // seven characters
    await form.save.click();

    await expect(form.dialog.getByText("Name must be at least 3 characters.")).toBeVisible();
    await expect(form.dialog.getByText("Password must be at least 8 characters.")).toBeVisible();
    await expect(form.name).toHaveAttribute("aria-invalid", "true");
    await expect(form.password).toHaveAttribute("aria-invalid", "true");
    await expect(form.dialog).toBeVisible();
    expect(patchRequests).toBe(0);
  });
});

test.describe("PATCH /api/users/:id", () => {
  // Uses the project's admin storage state on the `request` fixture.

  test("a new password revokes the user's existing sessions", async ({
    browser,
    baseURL,
    request,
  }) => {
    const agent = await createAgent(request, "Session Revoked Agent");

    const context = await anonymousContext(browser, baseURL);
    const page = await context.newPage();
    await signIn(page, agent.email, TEST_USER_PASSWORD);
    expect((await context.request.get("/api/me")).status()).toBe(200);

    const res = await request.patch(`/api/users/${agent.id}`, {
      data: { password: NEW_PASSWORD },
    });
    expect(res.status(), await res.text()).toBe(200);

    // The Session rows were deleted with the password change, so the cookie the
    // browser still holds is worthless and the client is bounced to /login.
    expect((await context.request.get("/api/me")).status()).toBe(401);
    await page.reload();
    await expect(page).toHaveURL("/login");
    await context.close();
  });

  test("a blank password leaves the account's password alone", async ({
    browser,
    baseURL,
    request,
  }) => {
    const agent = await createAgent(request, "Blank Password Agent");

    const res = await request.patch(`/api/users/${agent.id}`, {
      data: { name: "Blank Password Renamed", password: "" },
    });
    expect(res.status(), await res.text()).toBe(200);
    expect(((await res.json()) as { user: PublicUser }).user.name).toBe("Blank Password Renamed");

    const context = await anonymousContext(browser, baseURL);
    const signedIn = await signInViaApi(context.request, agent.email, TEST_USER_PASSWORD);
    expect(signedIn.status(), await signedIn.text()).toBe(200);
    await context.close();
  });

  test("a role-only body still works", async ({ request }) => {
    const agent = await createAgent(request, "Role Only Agent");

    const promoted = await request.patch(`/api/users/${agent.id}`, { data: { role: Role.ADMIN } });
    expect(promoted.status(), await promoted.text()).toBe(200);
    expect(((await promoted.json()) as { user: PublicUser }).user.role).toBe(Role.ADMIN);

    // Back down again: the seeded admin is still active, so this is not the
    // last-admin case.
    const demoted = await request.patch(`/api/users/${agent.id}`, { data: { role: Role.AGENT } });
    expect(demoted.status(), await demoted.text()).toBe(200);
    expect(((await demoted.json()) as { user: PublicUser }).user.role).toBe(Role.AGENT);
  });

  test("an active-only body still works", async ({ request }) => {
    const agent = await createAgent(request, "Active Only Agent");
    await deactivateUser(request, agent.id);

    const res = await request.patch(`/api/users/${agent.id}`, { data: { active: true } });
    expect(res.status(), await res.text()).toBe(200);
    expect(((await res.json()) as { user: PublicUser }).user.active).toBe(true);

    const off = await request.patch(`/api/users/${agent.id}`, { data: { active: false } });
    expect(off.status(), await off.text()).toBe(200);
    expect(((await off.json()) as { user: PublicUser }).user.active).toBe(false);
  });
});
