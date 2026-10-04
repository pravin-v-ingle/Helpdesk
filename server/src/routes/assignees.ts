import { Router } from "express";
import { requireAuth } from "../middleware/require-auth.ts";
import * as users from "../services/users.ts";

/**
 * Who a ticket can be assigned to.
 *
 * A route of its own rather than a path under `/api/users`, which is admin-only
 * from its first line: assigning a ticket is an agent's job, so an agent has to
 * be able to read this list. Mounting it here makes that visible at the mount
 * point instead of hiding a non-admin route above `usersRouter`'s gate, where
 * the next handler added could silently end up outside it.
 *
 * It is a deliberately thin slice of a user - id, name, email, role - and
 * nothing about the account's state; `services/users.ts` owns that choice.
 */
export const assigneesRouter: Router = Router();

// Same gate as the ticket queue: signed in, any role.
assigneesRouter.use(requireAuth);

assigneesRouter.get("/", async (_req, res) => {
  res.json({ assignees: await users.listAssignableUsers() });
});
