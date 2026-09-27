import { test, expect, type Page } from "@playwright/test";
import {
  createAgent,
  createUser,
  deactivateUser,
  deleteUser,
  fetchUser,
  Role,
  signInViaApi,
  TEST_USER_PASSWORD,
  type PublicUser,
} from "./helpers/api.ts";
import { anonymousContext, signIn, submitLogin } from "./helpers/auth.ts";

/**
 * Deleting a user - a soft delete. `DELETE /api/users/:id` writes both
 * `deletedAt` (the record that it was a deletion, and when) and
 * `active: false` (what actually blocks sign-in), which is why almost every
 * test here asserts the pair rather than either half. `PATCH { active: false }`
 * is the other, reversible removal and keeps `deletedAt` null; what it does to
 * an ordinary agent is `deactivation.spec.ts`'s subject, and only the guard it
 * shares with delete and the restore that undoes a deletion are tested here.
 *
 * The `request` fixture carries the seeded admin's session (the project's
 * storage state), so it can create, delete and read users; an account whose own
 * sign-in is under test gets a separate context with no cookies.
 */

// Set by the `session.create.before` hook in server/src/lib/auth.ts. Deletion
// deliberately reuses it: `active` is the single gate, so a deleted user is
// refused in the same words as a suspended one.
const DEACTIVATED_MESSAGE = "This account has been deactivated.";

const ADMIN_DELETE_REFUSAL = "An admin cannot be deleted. Change their role first.";
const ADMIN_DEACTIVATE_REFUSAL = "An admin cannot be deactivated. Change their role first.";
const SELF_REFUSAL = "You cannot deactivate your own account";

/**
 * A token shared by the users one test creates, so `?q=<token>` (a substring
 * match on name or email) narrows the list to exactly that test's rows and the
 * specs stay independent of each other and of the shared database's contents.
 */
function groupToken(label: string) {
  return `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Emails are lower-cased by Better Auth on the way in, so build them that way. */
function emailFor(token: string, who: string) {
  return `${token}-${who}@test.local`;
}

test.describe("DELETE /api/users/:id", () => {
  test("marks the account deleted and inactive together", async ({ request }) => {
    const agent = await createAgent(request, "Wire Invariant Agent");
    expect(agent.deletedAt).toBeNull();

    const deleted = await deleteUser(request, agent.id);

    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.active).toBe(false);

    // The same pair when read back, not just in the response to the write.
    const reread = await fetchUser(request, agent.id);
    expect(reread.deletedAt).toBe(deleted.deletedAt);
    expect(reread.active).toBe(false);
  });

  test("a deleted agent cannot sign in, and is told the account is deactivated", async ({
    browser,
    baseURL,
    request,
  }) => {
    const agent = await createAgent(request, "Deleted Agent");
    await deleteUser(request, agent.id);

    const context = await anonymousContext(browser, baseURL);
    const page = await context.newPage();
    await page.goto("/login");
    await submitLogin(page, agent.email, TEST_USER_PASSWORD);

    await expect(page.getByRole("alert").filter({ hasText: DEACTIVATED_MESSAGE })).toBeVisible();
    await expect(page).toHaveURL("/login");
    // No session was created for the refused sign-in.
    expect((await context.request.get("/api/me")).status()).toBe(401);

    await context.close();
  });

  test("a live session is killed by the deletion", async ({ browser, baseURL, request }) => {
    const agent = await createAgent(request, "Signed-in Deleted Agent");

    const context = await anonymousContext(browser, baseURL);
    const page = await context.newPage();
    await signIn(page, agent.email, TEST_USER_PASSWORD);
    expect((await context.request.get("/api/me")).status()).toBe(200);

    await deleteUser(request, agent.id);

    // The Session rows went with the delete, so the cookie the browser still
    // holds is worthless and the client is bounced to the login page.
    expect((await context.request.get("/api/me")).status()).toBe(401);
    await page.reload();
    await expect(page).toHaveURL("/login");

    await context.close();
  });

  test("deleting twice is harmless and keeps the first deletedAt", async ({ request }) => {
    const agent = await createAgent(request, "Twice Deleted Agent");

    const first = await deleteUser(request, agent.id);
    const second = await deleteUser(request, agent.id);

    expect(first.deletedAt).not.toBeNull();
    // A repeat is a no-op, not a fresh timestamp: when they were removed is
    // the point of recording it.
    expect(second.deletedAt).toBe(first.deletedAt);
    expect(second.active).toBe(false);
  });

  test("refuses to delete an admin and leaves the row untouched", async ({ request }) => {
    const admin = await createUser(request, {
      name: "Undeletable Admin",
      email: emailFor(groupToken("admin-delete"), "admin"),
      role: Role.ADMIN,
    });

    const res = await request.delete(`/api/users/${admin.id}`);

    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ error: ADMIN_DELETE_REFUSAL });

    // Not the last-admin case - the seeded admin is still active - so this is
    // the blanket refusal, and nothing was written.
    const after = await fetchUser(request, admin.id);
    expect(after.deletedAt).toBeNull();
    expect(after.active).toBe(true);
    expect(after.role).toBe(Role.ADMIN);
  });

  test("refuses to delete your own account, before noticing you are an admin", async ({
    request,
  }) => {
    const me = ((await (await request.get("/api/me")).json()) as { user: PublicUser }).user;

    const res = await request.delete(`/api/users/${me.id}`);

    expect(res.status()).toBe(400);
    // The self guard runs first, so the acting admin is told about themselves
    // rather than being sent off to demote themselves - which is also refused.
    expect(await res.json()).toEqual({ error: SELF_REFUSAL });

    const after = await fetchUser(request, me.id);
    expect(after.deletedAt).toBeNull();
    expect(after.active).toBe(true);
    // And the session that made the request still works.
    expect((await request.get("/api/me")).status()).toBe(200);
  });

  test("an admin can be deleted once they have been demoted", async ({ request }) => {
    const admin = await createUser(request, {
      name: "Demoted Then Deleted",
      email: emailFor(groupToken("demote-delete"), "admin"),
      role: Role.ADMIN,
    });

    const demoted = await request.patch(`/api/users/${admin.id}`, { data: { role: Role.AGENT } });
    expect(demoted.status(), await demoted.text()).toBe(200);
    expect(((await demoted.json()) as { user: PublicUser }).user.role).toBe(Role.AGENT);

    const deleted = await deleteUser(request, admin.id);
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.active).toBe(false);
  });
});

test.describe("PATCH /api/users/:id { active: ... }", () => {
  test("refuses to deactivate an admin who is not the acting one", async ({ request }) => {
    const admin = await createUser(request, {
      name: "Unsuspendable Admin",
      email: emailFor(groupToken("admin-deactivate"), "admin"),
      role: Role.ADMIN,
    });

    const res = await request.patch(`/api/users/${admin.id}`, { data: { active: false } });

    expect(res.status()).toBe(400);
    // The deactivate wording, not the delete one: the two routes share the
    // guard but each names its own action.
    expect(await res.json()).toEqual({ error: ADMIN_DEACTIVATE_REFUSAL });

    const after = await fetchUser(request, admin.id);
    expect(after.active).toBe(true);
    expect(after.deletedAt).toBeNull();
  });

  test("a restored user has deletedAt cleared and can sign in again", async ({
    browser,
    baseURL,
    request,
  }) => {
    const agent = await createAgent(request, "Restored Agent");
    await deleteUser(request, agent.id);

    const res = await request.patch(`/api/users/${agent.id}`, { data: { active: true } });
    expect(res.status(), await res.text()).toBe(200);
    const restored = ((await res.json()) as { user: PublicUser }).user;
    // Both halves are undone, so "deleted implies inactive" cannot be left
    // broken by a restore.
    expect(restored.active).toBe(true);
    expect(restored.deletedAt).toBeNull();

    const context = await anonymousContext(browser, baseURL);
    const signedIn = await signInViaApi(context.request, agent.email, TEST_USER_PASSWORD);
    expect(signedIn.status(), await signedIn.text()).toBe(200);
    await context.close();
  });
});

test.describe("GET /api/users?status=", () => {
  test("tells the three states apart", async ({ request }) => {
    const token = groupToken("status");
    const active = await createUser(request, {
      name: "Status Active Agent",
      email: emailFor(token, "active"),
    });
    const inactive = await createUser(request, {
      name: "Status Inactive Agent",
      email: emailFor(token, "inactive"),
    });
    const deleted = await createUser(request, {
      name: "Status Deleted Agent",
      email: emailFor(token, "deleted"),
    });
    await deactivateUser(request, inactive.id);
    await deleteUser(request, deleted.id);

    const emailsFor = async (status: string) => {
      const res = await request.get(`/api/users?q=${token}&status=${status}`);
      expect(res.status(), await res.text()).toBe(200);
      const { users } = (await res.json()) as { users: PublicUser[] };
      return users.map((user) => user.email).sort();
    };

    expect(await emailsFor("active")).toEqual([active.email]);
    // `inactive` is suspended-but-not-deleted, so the deleted row is excluded
    // even though it is also inactive.
    expect(await emailsFor("inactive")).toEqual([inactive.email]);
    expect(await emailsFor("deleted")).toEqual([deleted.email]);
  });

  test("refuses a status it does not know", async ({ request }) => {
    const res = await request.get("/api/users?status=archived");

    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ error: "status must be active, inactive, deleted" });
  });
});

/** The one row for a user; the email cell is unique per account. */
function rowFor(page: Page, email: string) {
  return page.getByRole("row").filter({ hasText: email });
}

/** Opens `/users` narrowed to one test's own rows and waits for the heading. */
async function openUsersPage(page: Page, token: string) {
  await page.goto(`/users?q=${token}`);
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
}

test.describe("Deleting a user from the users page", () => {
  // Uses the project's admin storage state.

  test("offers a delete button on an agent row but not on an admin row", async ({
    page,
    request,
  }) => {
    const token = groupToken("buttons");
    const agent = await createUser(request, {
      name: "Removable Agent",
      email: emailFor(token, "agent"),
    });
    const admin = await createUser(request, {
      name: "Protected Admin",
      email: emailFor(token, "admin"),
      role: Role.ADMIN,
    });

    await openUsersPage(page, token);

    const agentRow = rowFor(page, agent.email);
    await expect(agentRow).toBeVisible();
    await expect(agentRow.getByRole("button", { name: `Delete ${agent.name}` })).toBeVisible();

    // The server refuses to delete an admin, so the row offers no control for
    // it - only the edit that could demote them first.
    const adminRow = rowFor(page, admin.email);
    await expect(adminRow.getByRole("button", { name: `Edit ${admin.name}` })).toBeVisible();
    await expect(adminRow.getByRole("button", { name: `Delete ${admin.name}` })).toHaveCount(0);
  });

  test("asks for confirmation, and Cancel changes nothing", async ({ page, request }) => {
    const token = groupToken("cancel");
    const agent = await createUser(request, {
      name: "Spared Agent",
      email: emailFor(token, "agent"),
    });

    let deleteRequests = 0;
    page.on("request", (req) => {
      if (req.method() === "DELETE" && req.url().includes("/api/users/")) deleteRequests += 1;
    });

    await openUsersPage(page, token);
    const row = rowFor(page, agent.email);
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: `Delete ${agent.name}` }).click();

    const dialog = page.getByRole("alertdialog", { name: `Delete ${agent.name}?` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    // Nothing was sent, and the row is exactly as it was.
    expect(deleteRequests).toBe(0);
    await expect(row.getByText("Active", { exact: true })).toBeVisible();
    expect((await fetchUser(request, agent.id)).deletedAt).toBeNull();
  });

  test("confirming keeps the row in the list, reading Deleted", async ({ page, request }) => {
    const token = groupToken("confirm");
    const agent = await createUser(request, {
      name: "Doomed Agent",
      email: emailFor(token, "agent"),
    });

    await openUsersPage(page, token);
    const row = rowFor(page, agent.email);
    await expect(row.getByText("Active", { exact: true })).toBeVisible();

    await row.getByRole("button", { name: `Delete ${agent.name}` }).click();
    const dialog = page.getByRole("alertdialog", { name: `Delete ${agent.name}?` });
    await dialog.getByRole("button", { name: "Delete user" }).click();

    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    // A soft delete: the row is still listed, with the Status badge changed -
    // so the list really refetched after the mutation.
    await expect(row).toBeVisible();
    await expect(row.getByText("Deleted", { exact: true })).toBeVisible();
    expect((await fetchUser(request, agent.id)).deletedAt).not.toBeNull();
  });

  test("the Status filter's Deleted option narrows the list through the URL", async ({
    page,
    request,
  }) => {
    const token = groupToken("filter");
    const kept = await createUser(request, {
      name: "Filter Kept Agent",
      email: emailFor(token, "kept"),
    });
    const removed = await createUser(request, {
      name: "Filter Removed Agent",
      email: emailFor(token, "removed"),
    });
    await deleteUser(request, removed.id);

    await openUsersPage(page, token);
    await expect(rowFor(page, kept.email)).toBeVisible();
    await expect(rowFor(page, removed.email)).toBeVisible();

    await page.getByRole("combobox", { name: "Status" }).click();
    await page.getByRole("option", { name: "Deleted" }).click();

    // The filter lives in the URL, so a reload or Back keeps this view.
    await expect(page).toHaveURL(new RegExp(`\\?q=${token}&status=deleted$`));
    await expect(rowFor(page, removed.email)).toBeVisible();
    await expect(rowFor(page, kept.email)).toHaveCount(0);
  });
});
