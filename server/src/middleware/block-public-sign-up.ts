import type { RequestHandler } from "express";

/**
 * Closes Better Auth's public sign-up endpoints.
 *
 * `project-scope.md`: "There is no self-registration." The database is seeded
 * with one admin, and every other account is created by an admin through
 * POST /api/users.
 *
 * This has to sit in front of the Better Auth handler in app.ts. It only
 * blocks HTTP; `auth.api.signUpEmail()` called from our own code does not go
 * through Express, which is how the seed script and the users service still
 * create accounts. See the note in lib/auth.ts on why `disableSignUp` is not
 * used instead.
 */
export const blockPublicSignUp: RequestHandler = (req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
};
