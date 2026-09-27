import { test, expect, type Page } from "@playwright/test";
import {
  createUser,
  fetchUser,
  Role,
  TEST_USER_PASSWORD,
  type PublicUser,
} from "./helpers/api.ts";
import { signInAs } from "./helpers/auth.ts";

/**
 * Admin user management on `/users`, happy paths only: creating a user through
 * the "Add user" dialog, reading the list (columns, search, the Role filter,
 * paging, and the URL state behind all three), and one journey that walks a
 * single account through create, read, update and delete in order.
 *
 * Refusals and validation live elsewhere on purpose - `user-edit.spec.ts` has
 * the duplicate email and the short password, `deletion.spec.ts` and
 * `deactivation.spec.ts` have the server's guards, `api-guards.spec.ts` has the
 * 401/403s. Nothing here is expected to fail.
 *
 * Every test creates its own users with a token in both name and email and
 * opens the list as `?q=<token>`, so it sees only its own rows no matter what
 * the shared run has already put in the database. The seeded admin is never
 * touched: the rest of the suite signs in as it.
 */

/** A token shared by the users one test creates. Mirrors `deletion.spec.ts`. */
function groupToken(label: string) {
  return `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Emails are lower-cased by Better Auth on the way in, so build them that way. */
function emailFor(token: string, who: string) {
  return `${token}-${who}@test.local`;
}

/** The one row for a user; the email cell is unique per account. */
function rowFor(page: Page, email: string) {
  return page.getByRole("row").filter({ hasText: email });
}

/**
 * The list's search box, resolved by role rather than by label on purpose.
 * Every row's action buttons are named after the user (`Edit <name>`,
 * `Delete <name>`), so `getByLabel("Search")` - which matches an accessible
 * name by substring - also matches those buttons the moment any row's name
 * contains the word "Search", and strict mode rejects the locator. The
 * searchbox role is the only element on the page that can answer to this, so
 * it holds whatever the rows happen to be called. Do not go back to
 * `getByLabel`.
 */
function searchBox(page: Page) {
  return page.getByRole("searchbox", { name: "Search" });
}

function usersTable(page: Page) {
  // Named by `aria-label="Users"` on the real table. The loading skeleton is
  // deliberately unnamed, so this locator never matches the placeholder.
  return page.getByRole("table", { name: "Users" });
}

/**
 * Opens `/users`, usually narrowed to one test's own rows, and waits for the
 * real table rather than the skeleton. `search` is the query string without
 * its `?`; empty means the unfiltered list.
 */
async function openUsersPage(page: Page, search: string) {
  await page.goto(search === "" ? "/users" : `/users?${search}`);
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  await expect(usersTable(page)).toBeVisible();
}

/**
 * Which of `users` have a row on screen right now. Used where the order the
 * server pages rows in is not the point - call it after a web-first assertion
 * has settled the page.
 */
async function emailsPresent(page: Page, users: PublicUser[]): Promise<string[]> {
  const present: string[] = [];
  for (const user of users) {
    if ((await rowFor(page, user.email).count()) > 0) present.push(user.email);
  }
  return present.sort();
}

/** The "Add user" dialog's controls, resolved through their real labels. */
function createForm(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Add user" });
  return {
    dialog,
    name: dialog.getByLabel("Name"),
    email: dialog.getByLabel("Email"),
    password: dialog.getByLabel("Password"),
    submit: dialog.getByRole("button", { name: "Create user" }),
    cancel: dialog.getByRole("button", { name: "Cancel" }),
  };
}

/**
 * Fills the create dialog and submits it, then waits for the dialog to close -
 * which only happens once the mutation resolved.
 */
async function createUserThroughDialog(
  page: Page,
  user: { name: string; email: string; password: string },
) {
  await page.getByRole("button", { name: "Add user" }).click();
  const form = createForm(page);
  await expect(form.dialog).toBeVisible();

  await form.name.fill(user.name);
  await form.email.fill(user.email);
  await form.password.fill(user.password);
  await form.submit.click();

  await expect(page.getByRole("dialog")).toHaveCount(0);
}

test.describe("Creating a user from the users page", () => {
  // Uses the project's admin storage state.

  test("the Add user button opens a dialog with Name, Email and Password", async ({ page }) => {
    // An empty filter: the dialog is the subject, so no rows are wanted.
    await openUsersPage(page, `q=${groupToken("create-open")}`);

    await page.getByRole("button", { name: "Add user" }).click();

    const form = createForm(page);
    await expect(form.dialog).toBeVisible();
    // The dialog says what it will make, because there is no role picker.
    await expect(form.dialog).toContainText("The new account is created as an agent.");
    await expect(form.name).toHaveValue("");
    await expect(form.email).toHaveValue("");
    await expect(form.password).toHaveValue("");
    await expect(form.submit).toBeEnabled();
    await expect(form.cancel).toBeVisible();
  });

  test("creates an agent and adds it to the table", async ({ page, request }) => {
    const token = groupToken("create-row");
    const email = emailFor(token, "agent");
    const name = "Created Through The Dialog";

    await openUsersPage(page, `q=${token}`);
    // Nobody matches the token yet, so the row below can only be the new user.
    await expect(page.getByText("No users match your filters.")).toBeVisible();

    await createUserThroughDialog(page, { name, email, password: TEST_USER_PASSWORD });

    // The list was invalidated by the mutation and refetched itself.
    const row = rowFor(page, email);
    await expect(row).toBeVisible();
    await expect(row).toContainText(name);
    await expect(row.getByText("Agent", { exact: true })).toBeVisible();
    await expect(row.getByText("Active", { exact: true })).toBeVisible();

    // And the row stands for a real record, with the server's own defaults.
    const res = await request.get(`/api/users?q=${token}`);
    expect(res.status(), await res.text()).toBe(200);
    const { users } = (await res.json()) as { users: PublicUser[] };
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      name,
      email,
      role: Role.AGENT,
      active: true,
      deletedAt: null,
    });
  });

  test("the created account can sign in with the password that was typed", async ({
    page,
    browser,
    baseURL,
  }) => {
    const token = groupToken("create-signin");
    const email = emailFor(token, "agent");
    const name = "Can Sign In Agent";

    await openUsersPage(page, `q=${token}`);
    await createUserThroughDialog(page, { name, email, password: TEST_USER_PASSWORD });
    await expect(rowFor(page, email)).toBeVisible();

    // The point of the whole dialog: a person can now use the account. A fresh
    // context, because this one carries the admin's session.
    const { context, page: agentPage } = await signInAs(
      browser,
      baseURL,
      email,
      TEST_USER_PASSWORD,
    );
    await expect(agentPage.getByRole("heading", { name: `Welcome, ${name}` })).toBeVisible();
    await expect(agentPage.getByRole("banner").getByText("Agent", { exact: true })).toBeVisible();
    await context.close();
  });
});

test.describe("Reading the users list", () => {
  // Uses the project's admin storage state.

  test("renders the table's columns and a user's row", async ({ page, request }) => {
    const token = groupToken("list-row");
    const agent = await createUser(request, {
      name: "Listed Row Agent",
      email: emailFor(token, "agent"),
    });

    await openUsersPage(page, `q=${token}`);

    await expect(usersTable(page).getByRole("columnheader")).toHaveText([
      "Name",
      "Email",
      "Role",
      "Status",
      "Created",
      "Actions",
    ]);

    const row = rowFor(page, agent.email);
    await expect(row).toContainText(agent.name);
    await expect(row).toContainText(agent.email);
    await expect(row.getByText("Agent", { exact: true })).toBeVisible();
    await expect(row.getByText("Active", { exact: true })).toBeVisible();

    // The Created cell is formatted with the browser's locale, so the expected
    // string is computed there rather than in the test process.
    const formatted = await page.evaluate(
      (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }),
      agent.createdAt,
    );
    await expect(row).toContainText(formatted);
    // The machine-readable value beside it is the exact timestamp the API sent.
    await expect(row.locator("time")).toHaveAttribute("datetime", agent.createdAt);

    // Both per-row actions are offered on an agent.
    await expect(row.getByRole("button", { name: `Edit ${agent.name}` })).toBeVisible();
    await expect(row.getByRole("button", { name: `Delete ${agent.name}` })).toBeVisible();
  });

  test("search narrows the list and keeps the term in the URL", async ({ page, request }) => {
    const token = groupToken("search");
    const kept = await createUser(request, {
      name: "Narrowed Match Agent",
      email: emailFor(token, "kept"),
    });
    const dropped = await createUser(request, {
      name: "Excluded Match Agent",
      email: emailFor(token, "dropped"),
    });

    await openUsersPage(page, `q=${token}`);
    await expect(rowFor(page, kept.email)).toBeVisible();
    await expect(rowFor(page, dropped.email)).toBeVisible();

    // Typing is debounced into the URL; the web-first assertion waits it out.
    await searchBox(page).fill(`${token}-kept`);

    await expect(page).toHaveURL(`/users?q=${token}-kept`);
    await expect(rowFor(page, kept.email)).toBeVisible();
    await expect(rowFor(page, dropped.email)).toHaveCount(0);
    await expect(page.getByText("Showing 1–1 of 1")).toBeVisible();
  });

  test("the Role filter narrows the list and keeps the role in the URL", async ({
    page,
    request,
  }) => {
    const token = groupToken("role-filter");
    const agent = await createUser(request, {
      name: "Bucketed Agent Account",
      email: emailFor(token, "agent"),
    });
    const admin = await createUser(request, {
      name: "Bucketed Admin Account",
      email: emailFor(token, "admin"),
      role: Role.ADMIN,
    });

    await openUsersPage(page, `q=${token}`);
    await expect(rowFor(page, agent.email)).toBeVisible();
    await expect(rowFor(page, admin.email)).toBeVisible();

    const roleFilter = page.getByRole("combobox", { name: "Role" });
    await roleFilter.click();
    await page.getByRole("option", { name: "Agent" }).click();

    await expect(page).toHaveURL(`/users?q=${token}&role=${Role.AGENT}`);
    await expect(roleFilter).toContainText("Agent");
    await expect(rowFor(page, agent.email)).toBeVisible();
    await expect(rowFor(page, admin.email)).toHaveCount(0);

    await roleFilter.click();
    await page.getByRole("option", { name: "Admin" }).click();

    await expect(page).toHaveURL(`/users?q=${token}&role=${Role.ADMIN}`);
    await expect(rowFor(page, admin.email)).toBeVisible();
    await expect(rowFor(page, agent.email)).toHaveCount(0);
  });

  test("Next and Previous move between pages and stop at the ends", async ({ page, request }) => {
    const token = groupToken("paging");
    const agents: PublicUser[] = [];
    for (const who of ["one", "two", "three"]) {
      agents.push(
        await createUser(request, {
          name: `Paged Agent ${who}`,
          email: emailFor(token, who),
        }),
      );
    }
    const allEmails = agents.map((agent) => agent.email).sort();

    // `pageSize` has no control of its own; it is URL state, which is exactly
    // what makes two pages out of three rows here.
    await openUsersPage(page, `q=${token}&pageSize=2`);

    const previous = page.getByRole("button", { name: "Previous" });
    const next = page.getByRole("button", { name: "Next" });

    await expect(page.getByText("Showing 1–2 of 3")).toBeVisible();
    await expect(page.getByText("Page 1 of 2")).toBeVisible();
    await expect(previous).toBeDisabled();
    await expect(next).toBeEnabled();

    // Which two rows land on the first page depends on their creation order,
    // so the pages are compared as sets: no row is missing and none is on both.
    const firstPage = await emailsPresent(page, agents);
    expect(firstPage).toHaveLength(2);

    await next.click();

    await expect(page).toHaveURL(`/users?q=${token}&pageSize=2&page=2`);
    await expect(page.getByText("Showing 3–3 of 3")).toBeVisible();
    await expect(page.getByText("Page 2 of 2")).toBeVisible();
    await expect(previous).toBeEnabled();
    await expect(next).toBeDisabled();

    const secondPage = await emailsPresent(page, agents);
    expect(secondPage).toHaveLength(1);
    expect([...firstPage, ...secondPage].sort()).toEqual(allEmails);

    await previous.click();

    // Page 1 is stored as the absence of `page`, so the URL is the one we began
    // with rather than `page=1`.
    await expect(page).toHaveURL(`/users?q=${token}&pageSize=2`);
    await expect(page.getByText("Showing 1–2 of 3")).toBeVisible();
    await expect(previous).toBeDisabled();
  });

  test("a filtered, paged URL comes back to the same view after a reload", async ({
    page,
    request,
  }) => {
    const token = groupToken("reload");
    const agents: PublicUser[] = [];
    for (const who of ["one", "two", "three"]) {
      agents.push(
        await createUser(request, { name: `Reload Agent ${who}`, email: emailFor(token, who) }),
      );
    }

    const search = `q=${token}&role=${Role.AGENT}&pageSize=2&page=2`;
    await openUsersPage(page, search);

    await expect(page.getByText("Showing 3–3 of 3")).toBeVisible();
    const before = await emailsPresent(page, agents);
    expect(before).toHaveLength(1);

    await page.reload();

    // Every filter is read back out of the URL, so the view is rebuilt exactly:
    // same page of the same filtered list, and the controls show it.
    await expect(page).toHaveURL(`/users?${search}`);
    await expect(usersTable(page)).toBeVisible();
    await expect(page.getByText("Showing 3–3 of 3")).toBeVisible();
    await expect(page.getByText("Page 2 of 2")).toBeVisible();
    await expect(searchBox(page)).toHaveValue(token);
    await expect(page.getByRole("combobox", { name: "Role" })).toContainText("Agent");
    expect(await emailsPresent(page, agents)).toEqual(before);
  });
});

test.describe("A user's whole lifecycle", () => {
  /**
   * Create, read, update and delete against one row, in order. Parts of this
   * are covered on their own elsewhere - the create dialog above, renaming in
   * `user-edit.spec.ts`, the delete confirmation in `deletion.spec.ts` - and
   * the overlap is deliberate: this is the only test that shows the four
   * operations composing on a single account, so a change that breaks the
   * sequence (a stale cache after a create, a row that the search cannot find
   * again, an edit that the delete dialog does not pick up) fails here even
   * when every isolated test still passes. Do not delete it as a duplicate.
   */
  test("creates, finds, renames and deletes one agent", async ({ page, request }) => {
    const token = groupToken("lifecycle");
    const email = emailFor(token, "agent");
    const name = "Lifecycle Agent";
    const renamed = "Lifecycle Agent Renamed";

    // --- Create, from the unfiltered list -----------------------------------
    await openUsersPage(page, "");
    await createUserThroughDialog(page, { name, email, password: TEST_USER_PASSWORD });

    // Newest active account first, so the new row is at the top of page 1.
    await expect(rowFor(page, email)).toBeVisible();

    // --- Read: find it again through the search box -------------------------
    await searchBox(page).fill(token);
    await expect(page).toHaveURL(`/users?q=${token}`);
    await expect(page.getByText("Showing 1–1 of 1")).toBeVisible();

    const row = rowFor(page, email);
    await expect(row).toContainText(name);
    await expect(row.getByText("Agent", { exact: true })).toBeVisible();
    await expect(row.getByText("Active", { exact: true })).toBeVisible();

    // --- Update: rename it through the row's edit dialog --------------------
    await row.getByRole("button", { name: `Edit ${name}` }).click();
    const editDialog = page.getByRole("dialog", { name: "Edit user" });
    await expect(editDialog.getByLabel("Name")).toHaveValue(name);
    await editDialog.getByLabel("Name").fill(renamed);
    await editDialog.getByRole("button", { name: "Save changes" }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(row).toContainText(renamed);
    // The action buttons are named from the saved row, so the list refetched.
    await expect(row.getByRole("button", { name: `Edit ${renamed}` })).toBeVisible();

    // --- Delete: confirm the row's delete dialog ----------------------------
    await row.getByRole("button", { name: `Delete ${renamed}` }).click();
    const confirm = page.getByRole("alertdialog", { name: `Delete ${renamed}?` });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Delete user" }).click();

    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    // A soft delete: the same row, still carrying the edited name, now Deleted.
    await expect(row).toBeVisible();
    await expect(row).toContainText(renamed);
    await expect(row.getByText("Deleted", { exact: true })).toBeVisible();

    const { users } = (await (await request.get(`/api/users?q=${token}`)).json()) as {
      users: PublicUser[];
    };
    expect(users).toHaveLength(1);
    const saved = await fetchUser(request, users[0]!.id);
    expect(saved).toMatchObject({ name: renamed, email, active: false });
    expect(saved.deletedAt).not.toBeNull();
  });
});
