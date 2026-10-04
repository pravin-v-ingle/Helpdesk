import { Prisma, Role, TicketStatus } from "../generated/prisma/client.ts";
import { prisma } from "../lib/prisma.ts";
import { createUserWithPassword, setUserPassword } from "../lib/auth-accounts.ts";
import { serializable } from "../lib/transaction.ts";
import { HttpError } from "../middleware/error-handler.ts";

/** The user shape the API returns. Never widen this to `include` credentials. */
const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  active: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.UserSelect;

export type PublicUser = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>;

/**
 * The three states a user can be in, as one filter value. `active` and
 * `deletedAt` together can express a fourth combination that is never
 * written, so one parameter is offered rather than two booleans.
 */
export type UserStatus = "active" | "inactive" | "deleted";

/**
 * The columns the list can be ordered by. The members are exactly the column
 * ids the client's table uses, so the header the admin clicks, the parameter on
 * the wire and the key into `ORDER_BY` below are one string. Mirrored in
 * `client/src/lib/users.ts`, the same arrangement `UserStatus` already has.
 */
export type UserSortBy = "name" | "email" | "role" | "status" | "createdAt";

/** Declared per service rather than shared - see the note in `tickets.ts`. */
export type SortDir = "asc" | "desc";

export type ListUsersOptions = {
  /** Trimmed, non-empty. Case-insensitive substring of name or email. */
  q?: string;
  role?: Role;
  status?: UserStatus;
  /**
   * Optional, unlike the ticket list's, which the route defaults. The users
   * default is a composite that no `sortBy` member names, so there is no value
   * the route could default to - the absence is itself the instruction, and
   * only the service knows what it means.
   */
  sortBy?: UserSortBy;
  sortDir?: SortDir;
  /** 1-based. */
  page: number;
  pageSize: number;
};

/** One `where` fragment per status, so the mapping lives in one place. */
const STATUS_FILTERS: Record<UserStatus, Prisma.UserWhereInput> = {
  active: { active: true },
  inactive: { active: false, deletedAt: null },
  deleted: { deletedAt: { not: null } },
};

/**
 * Active accounts first, then newest. The admin page reads top-down. No
 * `sortBy` names this: it is a composite, and it is what `/users` shows when
 * the URL asks for no particular column - which is why a bare `/users` shows
 * no column as sorted rather than pretending one of them describes this.
 * `id` breaks `createdAt` ties so a row cannot appear on two pages.
 */
const DEFAULT_ORDER_BY: Prisma.UserOrderByWithRelationInput[] = [
  { active: "desc" },
  { createdAt: "desc" },
  { id: "asc" },
];

/**
 * One `orderBy` fragment per sortable column, keyed by the union so adding a
 * column is a compile error until it has an ordering.
 */
const ORDER_BY: Record<UserSortBy, (dir: SortDir) => Prisma.UserOrderByWithRelationInput[]> = {
  name: (dir) => [{ name: dir }],
  email: (dir) => [{ email: dir }],
  role: (dir) => [{ role: dir }],
  // The three-way Status the table shows, which is derived from `active` plus
  // `deletedAt` rather than stored. On `desc` this is Active -> Inactive ->
  // Deleted: `active desc` puts the live rows first, and Postgres sorts NULLs
  // first on DESC, so inactive (`deletedAt` null) precedes deleted. `asc` is
  // the exact mirror.
  status: (dir) => [{ active: dir }, { deletedAt: dir }],
  createdAt: (dir) => [{ createdAt: dir }],
};

/**
 * One page of users plus the total matching the same filters. A page past the
 * end returns no users with the real total; the caller decides where to go.
 */
export async function listUsers(options: ListUsersOptions) {
  const where: Prisma.UserWhereInput = {
    ...(options.role !== undefined && { role: options.role }),
    ...(options.status !== undefined && STATUS_FILTERS[options.status]),
    ...(options.q !== undefined && {
      OR: [
        { name: { contains: options.q, mode: "insensitive" } },
        { email: { contains: options.q, mode: "insensitive" } },
      ],
    }),
  };

  // A `sortDir` with no `sortBy` is accepted and ignored: it names no column.
  // The client writes both keys or neither.
  const dir = options.sortDir ?? "desc";
  const orderBy =
    options.sortBy === undefined
      ? DEFAULT_ORDER_BY
      : // The unique tiebreaker is appended in one place, so no key can be
        // added without it and no row can straddle a page.
        [...ORDER_BY[options.sortBy](dir), { id: "asc" as const }];

  const [users, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      select: publicUserSelect,
      // The whole result set is ordered here, not the visible page.
      orderBy,
      skip: (options.page - 1) * options.pageSize,
      take: options.pageSize,
    }),
    prisma.user.count({ where }),
  ]);

  return { users, total };
}

/**
 * The shape the ticket assignee picker needs - a name to show and an id to
 * write back. Narrower than `publicUserSelect` on purpose: this list is
 * readable by every signed-in user, not just admins, so it carries nothing
 * about an account's state. The role rides along because two people can share
 * a name and an admin in the list should not look like a second agent.
 */
const assignableUserSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
} as const satisfies Prisma.UserSelect;

export type AssignableUser = Prisma.UserGetPayload<{ select: typeof assignableUserSelect }>;

/**
 * Everyone a ticket can be given to: the active accounts, by name.
 *
 * `active: true` is the whole filter because a deleted row always carries
 * `active: false` (see `deleteUser`), so the one gate covers both removals -
 * the same single gate every other access check consults.
 *
 * Admins are included alongside agents. Working tickets is not an admin
 * privilege, but it is not forbidden them either: `/api/tickets` is open to
 * every signed-in user and the nav bar shows an admin the queue, so an admin
 * who picks a ticket up must be able to be the one holding it.
 *
 * Unpaginated, unlike `listUsers`. A helpdesk's staff list is tens of rows and
 * a picker has to show all of them at once; revisit if this ever outgrows a
 * dropdown.
 */
export async function listAssignableUsers(): Promise<AssignableUser[]> {
  return prisma.user.findMany({
    where: { active: true },
    select: assignableUserSelect,
    // `id` breaks the tie, so two people with the same name hold a stable
    // order rather than swapping places between requests.
    orderBy: [{ name: "asc" }, { id: "asc" }],
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
  // Already trimmed and lowercased by the shared schema; normalised again here
  // because the seed script calls this service directly, without it.
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
  input: { name?: string; email?: string; password?: string; role?: Role },
  actingUserId: string,
) {
  const updated = await serializable(async (tx) => {
    const user = await getUser(id, tx);

    // An admin demoting themselves would lose access to this page mid-request.
    if (input.role && input.role !== user.role && id === actingUserId) {
      throw new HttpError(400, "You cannot change your own role");
    }

    if (input.role && input.role !== Role.ADMIN && user.role === Role.ADMIN) {
      await assertNotLastActiveAdmin(tx, id);
    }

    // The email is the sign-in identity, so a clash has to be reported rather
    // than left to the unique constraint's 500. Already normalised by the
    // shared schema; comparing against the stored value is therefore sound.
    if (input.email !== undefined && input.email !== user.email) {
      const taken = await tx.user.findUnique({
        where: { email: input.email },
        select: { id: true },
      });
      if (taken) throw new HttpError(409, "A user with that email already exists");
    }

    return tx.user.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.email !== undefined && { email: input.email }),
        ...(input.role !== undefined && { role: input.role }),
      },
      select: publicUserSelect,
    });
  });

  // Last, and outside the transaction above: the password is written through
  // Better Auth's own adapter, which has no way to join a Prisma transaction.
  // A failure here therefore leaves the profile change committed - the admin
  // sees the error and can retry the password on its own.
  if (input.password !== undefined) {
    await setUserPassword(id, input.password);
    // The old password is no longer the one on the account, so sessions opened
    // with it are revoked - the same reasoning as deactivation. This signs out
    // an admin who changes their own password; the client's 401 handling then
    // sends them to the login page.
    await prisma.session.deleteMany({ where: { userId: id } });
  }

  return updated;
}

/**
 * Hands the open tickets a removed user was holding back to the unassigned
 * queue. Work in progress cannot wait for an account that is gone, and a
 * ticket nobody holds is at least visible as nobody's; one assigned to a
 * deleted agent looks handled and is not.
 *
 * `OPEN` only, deliberately. On a `RESOLVED` or `CLOSED` ticket the assignee is
 * no longer a job queue but the record of who dealt with it - which is the
 * whole reason a user is soft-deleted rather than removed - so that is left
 * exactly as it was.
 *
 * Runs inside the caller's serializable transaction, with the removal itself,
 * so there is no instant where the account is suspended and an open ticket
 * still names it, and a failure takes both back. Returns nothing: both
 * endpoints answer with the user.
 *
 * Not undone by `reactivateUser`. Nothing records which tickets were taken
 * away, and a ticket another agent has since picked up must not be pulled back
 * from them.
 */
async function unassignOpenTickets(tx: Prisma.TransactionClient, userId: string) {
  await tx.ticket.updateMany({
    where: { assignedToId: userId, status: TicketStatus.OPEN },
    data: { assignedToId: null },
  });
}

/**
 * Suspends a user and deletes their sessions, so they are signed out
 * everywhere immediately rather than at the end of their session lifetime.
 * The row is kept: tickets they touched still need to name them - all but the
 * open ones, which `unassignOpenTickets` hands back to the queue.
 *
 * Distinct from `deleteUser` below: a deactivation is reversible housekeeping
 * and leaves `deletedAt` null, so the two are still told apart afterwards.
 */
export async function deactivateUser(id: string, actingUserId: string) {
  return serializable(async (tx) => {
    const user = await getUser(id, tx);

    // Self first. The acting user is always an admin - the route is admin-only -
    // so the role check below would otherwise match their own row too, and tell
    // them to demote themselves, which is refused in turn.
    if (id === actingUserId) {
      throw new HttpError(400, "You cannot deactivate your own account");
    }
    // No admin can be removed, not merely the last one - so there is no route
    // that takes an admin out of the system without a deliberate demotion
    // first. `assertNotLastActiveAdmin` is therefore unreachable from here; it
    // still guards `updateUser`'s demotion path.
    if (user.role === Role.ADMIN) {
      throw new HttpError(400, "An admin cannot be deactivated. Change their role first.");
    }
    if (!user.active) return user;

    const updated = await tx.user.update({
      where: { id },
      data: { active: false },
      select: publicUserSelect,
    });
    await unassignOpenTickets(tx, id);
    await tx.session.deleteMany({ where: { userId: id } });

    return updated;
  });
}

/**
 * Deletes a user, softly: `deletedAt` records that the removal was a deletion
 * and when, and `active: false` is what actually blocks sign-in, which is why
 * both are written together. Nothing is ever removed from the table - tickets
 * the person handled still have to name them - and `reactivateUser` undoes it.
 * What it does not undo is the unassignment: the open tickets this hands back
 * to the queue stay there. See `unassignOpenTickets`.
 */
export async function deleteUser(id: string, actingUserId: string) {
  return serializable(async (tx) => {
    const user = await getUser(id, tx);

    // The same message the deactivate path gives: from the account holder's
    // side it is the same refusal, and only one of the two can be meant.
    if (id === actingUserId) {
      throw new HttpError(400, "You cannot deactivate your own account");
    }
    if (user.role === Role.ADMIN) {
      throw new HttpError(400, "An admin cannot be deleted. Change their role first.");
    }
    // Already deleted: a repeated call is a no-op rather than a new timestamp.
    if (user.deletedAt !== null) return user;

    const updated = await tx.user.update({
      where: { id },
      data: { active: false, deletedAt: new Date() },
      select: publicUserSelect,
    });
    await unassignOpenTickets(tx, id);
    await tx.session.deleteMany({ where: { userId: id } });

    return updated;
  });
}

/**
 * Restores a user from either removed state. `deletedAt` is cleared along with
 * `active`, so the invariant "deleted implies inactive" cannot be left broken
 * by a reactivation.
 *
 * Their tickets do not come back with them. The removal gave the open ones to
 * the queue and recorded nothing about which they were, and by now someone else
 * may be holding them - see `unassignOpenTickets`.
 */
export async function reactivateUser(id: string) {
  await getUser(id);

  return prisma.user.update({
    where: { id },
    data: { active: true, deletedAt: null },
    select: publicUserSelect,
  });
}

/**
 * Stops the system being left with no one who can manage users. Guards the
 * demotion in `updateUser` only: since no admin can be deactivated or deleted
 * without being demoted first, that is now the one way to lose an admin. Only
 * sound inside a serializable transaction with the write that follows it: as a
 * plain read, two admins demoting each other at the same moment would both
 * count the other and both succeed.
 */
async function assertNotLastActiveAdmin(tx: Prisma.TransactionClient, id: string) {
  const otherActiveAdmins = await tx.user.count({
    where: { role: Role.ADMIN, active: true, id: { not: id } },
  });

  if (otherActiveAdmins === 0) {
    throw new HttpError(400, "The last active admin cannot be removed");
  }
}
