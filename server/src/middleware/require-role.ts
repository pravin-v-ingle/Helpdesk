import type { RequestHandler } from "express";
import type { Role } from "../generated/prisma/client.ts";
import { HttpError } from "./error-handler.ts";

/**
 * Restricts a route to the given roles. Always mount it after `requireAuth`,
 * which is what puts `req.user` in place:
 *
 *     router.use(requireAuth, requireRole("ADMIN"));
 *
 * A signed-in user with the wrong role gets a 403, not a 401 - they are
 * authenticated, just not allowed. Sending 401 would make the client's
 * redirect-to-login rule bounce them out of a valid session.
 */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      throw new HttpError(401, "Not authenticated");
    }

    // Better Auth types the additional field as nullable because it is not a
    // required input. The column is NOT NULL with a default, so this only
    // guards the type - and a user with no role should be refused anyway.
    const role = req.user.role;
    if (!role || !roles.includes(role)) {
      throw new HttpError(403, "Insufficient permissions");
    }

    next();
  };
}
