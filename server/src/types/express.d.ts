import type { auth } from "../lib/auth.ts";

/**
 * What `requireAuth()` puts on the request. Both are optional at the type
 * level because they are only set on routes that ran the middleware.
 */
declare global {
  namespace Express {
    interface Request {
      user?: typeof auth.$Infer.Session.user;
      session?: typeof auth.$Infer.Session.session;
    }
  }
}
