import { test, expect } from "@playwright/test";
import { createUser, TEST_USER_PASSWORD, uniqueEmail, type PublicUser } from "./helpers/api.ts";
import { ANONYMOUS_STORAGE_STATE, seededAdmin } from "./helpers/env.ts";

/**
 * Server-side guards exercised through the Vite origin (5174), the same path
 * the browser takes, so the proxy and headers behave as in real use.
 */

test.describe("API guards without a session", () => {
  test.use({ storageState: ANONYMOUS_STORAGE_STATE });

  test("public sign-up is not found", async ({ request }) => {
    const res = await request.post("/api/auth/sign-up/email", {
      data: {
        name: "Intruder",
        email: uniqueEmail("intruder"),
        password: TEST_USER_PASSWORD,
      },
    });

    expect(res.status()).toBe(404);
    // Our own 404 shape, not Better Auth's - the block sits in front of it.
    expect(await res.json()).toEqual({ error: "Not found: POST /api/auth/sign-up/email" });
  });

  test("the bare sign-up path is not found either", async ({ request }) => {
    const res = await request.post("/api/auth/sign-up", { data: {} });
    expect(res.status()).toBe(404);
  });

  test("GET /api/me answers 401", async ({ request }) => {
    const res = await request.get("/api/me");

    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ error: "Not authenticated" });
  });

  test("the users API answers 401", async ({ request }) => {
    expect((await request.get("/api/users")).status()).toBe(401);
    expect(
      (
        await request.post("/api/users", {
          data: { name: "X", email: uniqueEmail("anon"), password: TEST_USER_PASSWORD },
        })
      ).status(),
    ).toBe(401);
  });

  test("a forged session cookie is rejected", async ({ request }) => {
    const res = await request.get("/api/me", {
      headers: { cookie: "better-auth.session_token=not-a-real-token" },
    });

    expect(res.status()).toBe(401);
  });
});

test.describe("API guards as the admin", () => {
  // Uses the project's admin storage state.
  test("GET /api/me returns the seeded admin as a PublicUser", async ({ request }) => {
    const res = await request.get("/api/me");

    expect(res.status()).toBe(200);
    const { user } = (await res.json()) as { user: PublicUser };
    expect(user).toMatchObject({
      email: seededAdmin.email,
      name: seededAdmin.name,
      role: "ADMIN",
      active: true,
    });
    expect(Object.keys(user).sort()).toEqual(
      ["active", "createdAt", "email", "id", "name", "role", "updatedAt"].sort(),
    );
  });

  test("ignores `active` in a create body", async ({ request }) => {
    const res = await request.post("/api/users", {
      data: {
        name: "Active Ignored",
        email: uniqueEmail("active-ignored"),
        password: TEST_USER_PASSWORD,
        active: false,
      },
    });

    expect(res.status(), await res.text()).toBe(201);
    expect(((await res.json()) as { user: PublicUser }).user.active).toBe(true);
  });

  test("falls back to AGENT for an unknown role in a create body", async ({ request }) => {
    const res = await request.post("/api/users", {
      data: {
        name: "Bad Role",
        email: uniqueEmail("bad-role"),
        password: TEST_USER_PASSWORD,
        role: "SUPERUSER",
      },
    });

    expect(res.status(), await res.text()).toBe(201);
    expect(((await res.json()) as { user: PublicUser }).user.role).toBe("AGENT");
  });

  test("refuses a password shorter than Better Auth's minimum", async ({ request }) => {
    const res = await request.post("/api/users", {
      data: { name: "Short", email: uniqueEmail("short-pw"), password: "short" },
    });

    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ error: "Password must be at least 8 characters" });
  });

  test("refuses a duplicate email with 409", async ({ request }) => {
    const email = uniqueEmail("dup");
    await createUser(request, { name: "First", email });

    const res = await request.post("/api/users", {
      data: { name: "Second", email: email.toUpperCase(), password: TEST_USER_PASSWORD },
    });

    expect(res.status()).toBe(409);
    expect(await res.json()).toEqual({ error: "A user with that email already exists" });
  });

  test("refuses to deactivate the acting admin", async ({ request }) => {
    const me = ((await (await request.get("/api/me")).json()) as { user: PublicUser }).user;

    const viaDelete = await request.delete(`/api/users/${me.id}`);
    expect(viaDelete.status()).toBe(400);
    expect(await viaDelete.json()).toEqual({ error: "You cannot deactivate your own account" });

    const viaPatch = await request.patch(`/api/users/${me.id}`, { data: { active: false } });
    expect(viaPatch.status()).toBe(400);
    expect(await viaPatch.json()).toEqual({ error: "You cannot deactivate your own account" });

    // Still an active admin with a working session.
    const after = await request.get("/api/me");
    expect(after.status()).toBe(200);
    expect(((await after.json()) as { user: PublicUser }).user.active).toBe(true);
  });

  test("refuses to change the acting admin's role", async ({ request }) => {
    const me = ((await (await request.get("/api/me")).json()) as { user: PublicUser }).user;

    const res = await request.patch(`/api/users/${me.id}`, { data: { role: "AGENT" } });
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ error: "You cannot change your own role" });

    const after = ((await (await request.get("/api/me")).json()) as { user: PublicUser }).user;
    expect(after.role).toBe("ADMIN");
  });

  test("returns 404 for an unknown user id", async ({ request }) => {
    const res = await request.get("/api/users/does-not-exist");

    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ error: "User not found" });
  });
});
