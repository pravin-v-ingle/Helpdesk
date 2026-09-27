import { expect, type APIRequestContext } from "@playwright/test";

/**
 * Mirrors `enum Role` in `server/prisma/schema.prisma` (and the `Role` const in
 * `client/src/lib/api.ts`). Declared here because the e2e workspace cannot
 * import from either; change it whenever the schema's enum changes.
 */
export const Role = {
  ADMIN: "ADMIN",
  AGENT: "AGENT",
} as const;

export type Role = (typeof Role)[keyof typeof Role];

/**
 * The user shape `/api/users` and `/api/me` return - mirrors `PublicUser` in
 * `client/src/lib/api.ts`. Declared here rather than imported so the specs do
 * not depend on either workspace.
 */
export type PublicUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  deletedAt: string | null;
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
  input: { name: string; email: string; password?: string; role?: Role },
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

/**
 * Suspends a user through `PATCH /api/users/:id { active: false }` as the
 * admin: `active` goes false and `deletedAt` stays null. Deliberately not
 * `DELETE`, which is the other removal - see `deleteUser` below.
 */
export async function deactivateUser(
  request: APIRequestContext,
  id: string,
): Promise<PublicUser> {
  const res = await request.patch(`/api/users/${id}`, { data: { active: false } });
  expect(res.status(), await res.text()).toBe(200);
  const { user } = (await res.json()) as { user: PublicUser };
  return user;
}

/**
 * Deletes a user through `DELETE /api/users/:id` as the admin. A soft delete:
 * the row stays, with `deletedAt` set and `active` false.
 */
export async function deleteUser(
  request: APIRequestContext,
  id: string,
): Promise<PublicUser> {
  const res = await request.delete(`/api/users/${id}`);
  expect(res.status(), await res.text()).toBe(200);
  const { user } = (await res.json()) as { user: PublicUser };
  return user;
}

/** Reads one user through `GET /api/users/:id` as the admin. */
export async function fetchUser(
  request: APIRequestContext,
  id: string,
): Promise<PublicUser> {
  const res = await request.get(`/api/users/${id}`);
  expect(res.status(), await res.text()).toBe(200);
  const { user } = (await res.json()) as { user: PublicUser };
  return user;
}

/**
 * Signs in through Better Auth's endpoint in `request`'s own cookie jar, and
 * returns the raw response so a caller can assert whether the password was
 * accepted. Use an isolated context (`anonymousContext`) - the project's
 * default `request` fixture already carries the admin's session.
 */
export function signInViaApi(request: APIRequestContext, email: string, password: string) {
  return request.post("/api/auth/sign-in/email", { data: { email, password } });
}
