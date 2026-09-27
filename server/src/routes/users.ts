import { createUserSchema, updateUserSchema } from "@helpdesk/core/schemas/users";
import { Router, type Request } from "express";
import { Role } from "../generated/prisma/client.ts";
import { requireAuth } from "../middleware/require-auth.ts";
import { requireRole } from "../middleware/require-role.ts";
import { HttpError } from "../middleware/error-handler.ts";
import { parseBody } from "../lib/validate.ts";
import * as users from "../services/users.ts";

export const usersRouter: Router = Router();

// Everything below is admin-only. project-scope.md: agents cannot manage users.
usersRouter.use(requireAuth, requireRole(Role.ADMIN));

usersRouter.get("/", async (req, res) => {
  const query = parseListQuery(req.query);
  const { users: list, total } = await users.listUsers(query);
  res.json({ users: list, total, page: query.page, pageSize: query.pageSize });
});

usersRouter.get("/:id", async (req, res) => {
  res.json({ user: await users.getUser(req.params.id) });
});

usersRouter.post("/", async (req, res) => {
  const body = req.body ?? {};

  // The three fields the dialog collects are validated by the schema the
  // dialog itself uses. `role` is not part of it - it is server-owned - so it
  // is read from the body separately and defaulted here.
  const user = await users.createUser({
    ...parseBody(createUserSchema, body),
    role: parseRole(body.role) ?? Role.AGENT,
  });

  res.status(201).json({ user });
});

usersRouter.patch("/:id", async (req, res) => {
  const body = req.body ?? {};
  const id = req.params.id;
  const actingUserId = req.user!.id;

  // `active: true` restores a user from either removed state, and
  // `active: false` suspends one. Deleting is a different action with its own
  // record (`deletedAt`) and goes through DELETE below; both share the "not
  // yourself" and "no admins" guards in the service.
  if (body.active === false) {
    res.json({ user: await users.deactivateUser(id, actingUserId) });
    return;
  }

  // The edit form's fields go through the shared schema, which also drops a
  // blank password so "leave it alone" never reaches the service. `role` is
  // server-owned and no form sends it, so it is read off the body separately.
  const profile = parseBody(updateUserSchema, body);

  let user = await users.updateUser(
    id,
    {
      ...profile,
      ...(body.role !== undefined && { role: parseRoleOrThrow(body.role) }),
    },
    actingUserId,
  );

  if (body.active === true) user = await users.reactivateUser(id);

  res.json({ user });
});

/** A soft delete: the row stays, marked with `deletedAt` - see the service. */
usersRouter.delete("/:id", async (req, res) => {
  res.json({ user: await users.deleteUser(req.params.id, req.user!.id) });
});

// --- input validation -------------------------------------------------------
// Request bodies go through the shared schemas in `@helpdesk/core` (see
// `parseBody` above). What is left here is input no form sends: the
// server-owned `role`, and the list endpoint's query string.

/** Narrows an unknown request value to a member of the `Role` enum. */
function isRole(value: unknown): value is Role {
  return typeof value === "string" && Object.values<string>(Role).includes(value);
}

function parseRole(value: unknown): Role | undefined {
  if (value === undefined || value === null) return undefined;
  return isRole(value) ? value : undefined;
}

function parseRoleOrThrow(value: unknown): Role {
  const role = parseRole(value);
  if (!role) throw new HttpError(400, `role must be ${Object.values(Role).join(" or ")}`);
  return role;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_QUERY_LENGTH = 100;

/**
 * `GET /` query string. A repeated key (`?page=1&page=2`) arrives as an array
 * and takes the same 400 as an invalid value.
 */
function parseListQuery(query: Request["query"]): users.ListUsersOptions {
  return {
    q: parseSearch(query.q),
    role: query.role === undefined ? undefined : parseRoleOrThrow(query.role),
    status: query.status === undefined ? undefined : parseStatusOrThrow(query.status),
    page: parseIntParam(query.page, "page", 1),
    pageSize: parseIntParam(query.pageSize, "pageSize", DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  };
}

function parseSearch(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "q must be a string");
  const q = value.trim();
  if (q === "") return undefined;
  if (q.length > MAX_QUERY_LENGTH) {
    throw new HttpError(400, `q must be at most ${MAX_QUERY_LENGTH} characters`);
  }
  return q;
}

/**
 * Every member of `UserStatus`, keyed by itself so the compiler demands a new
 * entry when a fourth status is added - a `satisfies UserStatus[]` array would
 * only check that each member is a status, not that none is missing.
 */
const USER_STATUSES: Record<users.UserStatus, true> = {
  active: true,
  inactive: true,
  deleted: true,
};

/** Narrows an unknown request value - a query parameter - to a `UserStatus`. */
function isUserStatus(value: unknown): value is users.UserStatus {
  return typeof value === "string" && Object.hasOwn(USER_STATUSES, value);
}

/**
 * The list's Status filter. One parameter rather than `active` plus `deleted`
 * booleans, which together could ask for a combination that never exists.
 */
function parseStatusOrThrow(value: unknown): users.UserStatus {
  if (isUserStatus(value)) return value;
  throw new HttpError(400, `status must be ${Object.keys(USER_STATUSES).join(", ")}`);
}

/**
 * Digits only: `Number()` would accept `1e2`, ` 7` and `0x10`. Omitting the
 * parameter gives `fallback`; anything else must be a positive integer, at
 * most `max` when one is given.
 */
function parseIntParam(value: unknown, field: string, fallback: number, max?: number): number {
  if (value === undefined) return fallback;

  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || (max !== undefined && parsed > max)) {
    throw new HttpError(
      400,
      max === undefined
        ? `${field} must be a positive integer`
        : `${field} must be an integer between 1 and ${max}`,
    );
  }
  return parsed;
}
