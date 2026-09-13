import { Prisma, type Role } from "../generated/prisma/client.ts";
import { prisma } from "../lib/prisma.ts";
import { createUserWithPassword } from "../lib/auth-accounts.ts";
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

export async function getUser(id: string, db: Prisma.TransactionClient = prisma) {
  const user = await db.user.findUnique({
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
  // row is written the way Better Auth expects it. Sign-up is disabled, so this
  // takes the internal-adapter path - see lib/auth-accounts.ts.
  const created = await createUserWithPassword({
    name: input.name.trim(),
    email,
    password: input.password,
  });

  // `role` is `input: false` in the auth config and the create path above never
  // sets it, so every new user starts as the AGENT default. Anything else is
  // set here, deliberately, after the fact.
  return prisma.user.update({
    where: { id: created.id },
    data: { role: input.role },
    select: publicUserSelect,
  });
}

export async function updateUser(
  id: string,
  input: { name?: string; role?: Role },
  actingUserId: string,
) {
  return serializable(async (tx) => {
    const user = await getUser(id, tx);

    // An admin demoting themselves would lose access to this page mid-request.
    if (input.role && input.role !== user.role && id === actingUserId) {
      throw new HttpError(400, "You cannot change your own role");
    }

    if (input.role && input.role !== "ADMIN" && user.role === "ADMIN") {
      await assertNotLastActiveAdmin(tx, id);
    }

    return tx.user.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.role !== undefined && { role: input.role }),
      },
      select: publicUserSelect,
    });
  });
}

/**
 * Deactivates a user and deletes their sessions, so they are signed out
 * everywhere immediately rather than at the end of their session lifetime.
 * The row is kept: tickets they touched still need to name them.
 */
export async function deactivateUser(id: string, actingUserId: string) {
  return serializable(async (tx) => {
    const user = await getUser(id, tx);

    if (id === actingUserId) {
      throw new HttpError(400, "You cannot deactivate your own account");
    }
    if (!user.active) return user;
    if (user.role === "ADMIN") await assertNotLastActiveAdmin(tx, id);

    const updated = await tx.user.update({
      where: { id },
      data: { active: false },
      select: publicUserSelect,
    });
    await tx.session.deleteMany({ where: { userId: id } });

    return updated;
  });
}

export async function reactivateUser(id: string) {
  await getUser(id);

  return prisma.user.update({
    where: { id },
    data: { active: true },
    select: publicUserSelect,
  });
}

/**
 * Stops the system being left with no one who can manage users. Only sound
 * inside a serializable transaction with the write that follows it: as a
 * plain read, two admins removing each other at the same moment would both
 * count the other and both succeed.
 */
async function assertNotLastActiveAdmin(tx: Prisma.TransactionClient, id: string) {
  const otherActiveAdmins = await tx.user.count({
    where: { role: "ADMIN", active: true, id: { not: id } },
  });

  if (otherActiveAdmins === 0) {
    throw new HttpError(400, "The last active admin cannot be removed");
  }
}

/**
 * Postgres refused to commit because a concurrent transaction got there first
 * (SQLSTATE 40001). Prisma reports it two ways: as `P2034` on the classic
 * path, and through the driver adapter as a `DriverAdapterError` whose cause
 * is `TransactionWriteConflict` - the form `@prisma/adapter-pg` produces
 * almost every time.
 */
function isSerializationFailure(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code === "P2034";
  if (err instanceof Error && err.name === "DriverAdapterError") {
    const cause = err.cause as { kind?: string } | undefined;
    return cause?.kind === "TransactionWriteConflict";
  }
  return false;
}

const SERIALIZABLE_ATTEMPTS = 3;

/**
 * Runs `fn` in a serializable transaction, so a check it makes (an admin
 * count, say) still holds when its write commits. Postgres aborts one side
 * of a conflict rather than letting both through; that side is retried.
 */
async function serializable<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (err) {
      if (!isSerializationFailure(err) || attempt >= SERIALIZABLE_ATTEMPTS) throw err;
    }
  }
}
