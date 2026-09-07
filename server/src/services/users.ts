import { APIError } from "better-auth/api";
import type { Role } from "../generated/prisma/client.ts";
import { prisma } from "../lib/prisma.ts";
import { auth } from "../lib/auth.ts";
import { HttpError } from "../middleware/error-handler.ts";

/** The user shape the API returns. Never widen this to `include` credentials. */
const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type PublicUser = Awaited<ReturnType<typeof listUsers>>[number];

export function listUsers() {
  return prisma.user.findMany({
    select: publicUserSelect,
    // Active accounts first, then newest. The admin page reads top-down.
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
  });
}

export async function getUser(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: publicUserSelect,
  });

  if (!user) throw new HttpError(404, "User not found");
  return user;
}

export async function createUser(input: {
  name: string;
  email: string;
  password: string;
  role: Role;
}) {
  const email = input.email.trim().toLowerCase();

  // Better Auth reports a duplicate as a generic failure. Checking first lets
  // us return a 409 that the admin page can show against the email field.
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existing) throw new HttpError(409, "A user with that email already exists");

  // Goes through Better Auth rather than Prisma so the password is hashed with
  // the same parameters sign-in verifies against, and the credential Account
  // row is written the way Better Auth expects it. `autoSignIn` is off, so no
  // session is created for the new user.
  let created;
  try {
    created = await auth.api.signUpEmail({
      body: { name: input.name.trim(), email, password: input.password },
    });
  } catch (err) {
    if (err instanceof APIError) {
      // Password length is the realistic case here; Better Auth enforces it.
      throw new HttpError(400, err.message);
    }
    throw err;
  }

  // `role` is `input: false` in the auth config, so sign-up always writes the
  // AGENT default. Anything else is set here, deliberately, after the fact.
  return prisma.user.update({
    where: { id: created.user.id },
    data: { role: input.role },
    select: publicUserSelect,
  });
}

export async function updateUser(
  id: string,
  input: { name?: string; role?: Role },
  actingUserId: string,
) {
  const user = await getUser(id);

  // An admin demoting themselves would lose access to this page mid-request.
  if (input.role && input.role !== user.role && id === actingUserId) {
    throw new HttpError(400, "You cannot change your own role");
  }

  if (input.role && input.role !== "ADMIN" && user.role === "ADMIN") {
    await assertNotLastActiveAdmin(id);
  }

  return prisma.user.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name.trim() }),
      ...(input.role !== undefined && { role: input.role }),
    },
    select: publicUserSelect,
  });
}

/**
 * Deactivates a user and deletes their sessions, so they are signed out
 * everywhere immediately rather than at the end of their session lifetime.
 * The row is kept: tickets they touched still need to name them.
 */
export async function deactivateUser(id: string, actingUserId: string) {
  const user = await getUser(id);

  if (id === actingUserId) {
    throw new HttpError(400, "You cannot deactivate your own account");
  }
  if (!user.active) return user;
  if (user.role === "ADMIN") await assertNotLastActiveAdmin(id);

  const [updated] = await prisma.$transaction([
    prisma.user.update({
      where: { id },
      data: { active: false },
      select: publicUserSelect,
    }),
    prisma.session.deleteMany({ where: { userId: id } }),
  ]);

  return updated;
}

export async function reactivateUser(id: string) {
  await getUser(id);

  return prisma.user.update({
    where: { id },
    data: { active: true },
    select: publicUserSelect,
  });
}

/** Stops the system being left with no one who can manage users. */
async function assertNotLastActiveAdmin(id: string) {
  const otherActiveAdmins = await prisma.user.count({
    where: { role: "ADMIN", active: true, id: { not: id } },
  });

  if (otherActiveAdmins === 0) {
    throw new HttpError(400, "The last active admin cannot be removed");
  }
}
