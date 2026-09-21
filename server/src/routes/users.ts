import { createUserSchema } from "@helpdesk/core/schemas/users";
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

  // `active: true` is the reactivate path. Deactivation goes through DELETE,
  // which is also where the "not yourself" and "not the last admin" guards are.
  if (body.active === false) {
    res.json({ user: await users.deactivateUser(id, actingUserId) });
    return;
  }

  let user = await users.updateUser(
    id,
    {
      ...(body.name !== undefined && { name: requireString(body.name, "name") }),
      ...(body.role !== undefined && { role: parseRoleOrThrow(body.role) }),
    },
    actingUserId,
  );

  if (body.active === true) user = await users.reactivateUser(id);

  res.json({ user });
});

/** Deactivates rather than deletes - see the note on the service. */
usersRouter.delete("/:id", async (req, res) => {
  res.json({ user: await users.deactivateUser(req.params.id, req.user!.id) });
});

// --- input validation -------------------------------------------------------
// Bodies that a client form also validates go through the shared schema in
// `@helpdesk/core` (see `parseBody` above). What is left here is server-only
// input: the PATCH fields and the role, which no form sends.

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `${field} is required`);
  }
  return value;
}

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
    active: parseBoolean(query.active, "active"),
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

function parseBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new HttpError(400, `${field} must be true or false`);
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
