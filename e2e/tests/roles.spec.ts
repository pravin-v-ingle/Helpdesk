import { test, expect, type Browser } from "@playwright/test";
import { createAgent, Role, TEST_USER_PASSWORD, type PublicUser } from "./helpers/api.ts";
import { signIn } from "./helpers/auth.ts";
import { ANONYMOUS_STORAGE_STATE, seededAdmin } from "./helpers/env.ts";

/**
 * A second, independent browser signed in as `agent`. The default context in
 * this project carries the admin's session, so the agent needs its own cookie
 * jar. Callers close it.
 */
async function openAgentBrowser(browser: Browser, baseURL: string | undefined, agent: PublicUser) {
  const context = await browser.newContext({ baseURL, storageState: ANONYMOUS_STORAGE_STATE });
  const page = await context.newPage();
  await signIn(page, agent.email, TEST_USER_PASSWORD);
  return { context, page };
}

test.describe("Admin role", () => {
  // Uses the project's admin storage state.
  test("shows the Users link and opens the users page", async ({ page }) => {
    await page.goto("/");

    const nav = page.getByRole("banner");
    await expect(nav.getByText("Admin", { exact: true })).toBeVisible();
    const usersLink = nav.getByRole("link", { name: "Users" });
    await expect(usersLink).toBeVisible();

    await usersLink.click();

    await expect(page).toHaveURL("/users");
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  });

  test("can list users through the API", async ({ request }) => {
    const res = await request.get("/api/users");

    expect(res.status()).toBe(200);
    const { users } = (await res.json()) as { users: PublicUser[] };
    expect(users.map((u) => u.email)).toContain(seededAdmin.email);
    // Nothing in the list must ever leak credentials.
    for (const user of users) expect(user).not.toHaveProperty("password");
  });

  test("a newly created user defaults to the AGENT role", async ({ request }) => {
    const agent = await createAgent(request, "Default Role Agent");

    expect(agent.role).toBe(Role.AGENT);
    expect(agent.active).toBe(true);
  });
});

test.describe("Agent role", () => {
  test("does not see the Users link and is shown as an agent", async ({
    browser,
    baseURL,
    request,
  }) => {
    const agent = await createAgent(request, "Nav Agent");
    const { context, page } = await openAgentBrowser(browser, baseURL, agent);

    const nav = page.getByRole("banner");
    await expect(nav.getByText(agent.name, { exact: true })).toBeVisible();
    await expect(nav.getByText("Agent", { exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Users" })).toHaveCount(0);
    await expect(
      page.getByText(`You are signed in as ${agent.email} with the agent role.`),
    ).toBeVisible();

    await context.close();
  });

  test("is sent home, not to /login, when opening /users directly", async ({
    browser,
    baseURL,
    request,
  }) => {
    const agent = await createAgent(request, "Redirect Agent");
    const { context, page } = await openAgentBrowser(browser, baseURL, agent);

    await page.goto("/users");

    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: `Welcome, ${agent.name}` })).toBeVisible();
    // Still signed in: the session was valid, the page just was not theirs.
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    await context.close();
  });

  test("gets 403, not 401, from the admin-only API", async ({ browser, baseURL, request }) => {
    const agent = await createAgent(request, "API Agent");
    const { context, page } = await openAgentBrowser(browser, baseURL, agent);

    const list = await context.request.get("/api/users");
    expect(list.status()).toBe(403);
    expect(await list.json()).toEqual({ error: "Insufficient permissions" });

    const create = await context.request.post("/api/users", {
      data: { name: "Nope", email: `nope-${Date.now()}@test.local`, password: TEST_USER_PASSWORD },
    });
    expect(create.status()).toBe(403);

    // The agent's own session is untouched by the refusal.
    const me = await context.request.get("/api/me");
    expect(me.status()).toBe(200);
    expect(((await me.json()) as { user: PublicUser }).user.email).toBe(agent.email);

    // And the browser was not bounced to the login page by it either.
    await page.reload();
    await expect(page).toHaveURL("/");

    await context.close();
  });
});
