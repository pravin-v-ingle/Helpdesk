import { Router } from "express";
import { requireAuth } from "../middleware/require-auth.ts";
import * as users from "../services/users.ts";

export const meRouter: Router = Router();

/**
 * The current user, for restoring client state on load and for deciding which
 * navigation an agent versus an admin sees.
 *
 * Better Auth's own `GET /api/auth/get-session` covers the same ground, but it
 * returns Better Auth's user shape - `emailVerified`, `image`, and `role` and
 * `active` typed as nullable because they are declared as optional additional
 * fields. This returns the same `PublicUser` the `/api/users` endpoints return,
 * so the client has one user type rather than two.
 *
 * `requireAuth` has already read the session, so this re-reads the user by
 * primary key. That is one extra indexed lookup on a route the client calls
 * once per load, bought in exchange for a single definition of the public
 * user shape in the users service.
 */
meRouter.get("/", requireAuth, async (req, res) => {
  res.json({ user: await users.getUser(req.user!.id) });
});
