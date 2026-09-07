import type { RequestHandler } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.ts";
import { HttpError } from "./error-handler.ts";

/**
 * Rejects unauthenticated requests with a 401 and attaches the session and its
 * user to the request otherwise. The lookup hits the database on every call -
 * see the note in lib/auth.ts on why there is no cookie cache.
 *
 * Express 5 forwards the rejected promise to the error handler, so the throw
 * below needs no try/catch here or in the route.
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const result = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  if (!result) throw new HttpError(401, "Not authenticated");

  // Deactivating a user deletes their sessions, so this should not normally
  // fire. It covers the gap between the two writes, and any session created
  // before a deactivation lands.
  if (!result.user.active) {
    throw new HttpError(401, "This account has been deactivated.");
  }

  req.user = result.user;
  req.session = result.session;
  next();
};
