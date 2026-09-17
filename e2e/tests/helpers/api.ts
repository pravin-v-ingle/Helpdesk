import { expect, type APIRequestContext } from "@playwright/test";

/**
 * The user shape `/api/users` and `/api/me` return - mirrors `PublicUser` in
 * `client/src/lib/api.ts`. Declared here rather than imported so the specs do
 * not depend on either workspace.
 */
export type PublicUser = {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "AGENT";
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Passwords for accounts the tests create. Better Auth requires 8..128 chars. */
export const TEST_USER_PASSWORD = "agent-password-123";

/**
 * A unique address per call, so a spec never collides with one that ran
 * earlier in the same database. Better Auth lower-cases emails on the way in,
 * so this stays lower-case too.
 */
export function uniqueEmail(prefix: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${suffix}@test.local`;
}

/**
 * Creates a user through `POST /api/users`. `request` must carry an admin
 * session - the `request` fixture does when the project uses the admin
 * storage state.
 */
export async function createUser(
  request: APIRequestContext,
  input: { name: string; email: string; password?: string; role?: "ADMIN" | "AGENT" },
): Promise<PublicUser> {
  const res = await request.post("/api/users", {
    data: {
      name: input.name,
      email: input.email,
      password: input.password ?? TEST_USER_PASSWORD,
      ...(input.role && { role: input.role }),
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { user } = (await res.json()) as { user: PublicUser };
  return user;
}

/** Creates an AGENT with a fresh email and the shared test password. */
export function createAgent(request: APIRequestContext, name = "Test Agent") {
  return createUser(request, { name, email: uniqueEmail("agent") });
}

/** Deactivates a user through `DELETE /api/users/:id` as the admin. */
export async function deactivateUser(
  request: APIRequestContext,
  id: string,
): Promise<PublicUser> {
  const res = await request.delete(`/api/users/${id}`);
  expect(res.status(), await res.text()).toBe(200);
  const { user } = (await res.json()) as { user: PublicUser };
  return user;
}
