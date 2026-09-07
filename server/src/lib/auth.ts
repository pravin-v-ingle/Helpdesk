import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { prisma } from "./prisma.ts";
import { env } from "../env.ts";

/**
 * Better Auth instance. Email and password only, with sessions stored in
 * Postgres through the shared Prisma client.
 *
 * No `secondaryStorage` and no `session.cookieCache` on purpose: both would
 * move session state out of the database, and a session row that can be deleted
 * is the reason `tech-stack.md` chose sessions over JWTs. Every request reads
 * the session from Postgres, so signing out kills it immediately.
 */
export const auth = betterAuth({
  appName: "Helpdesk",
  baseURL: env.betterAuthUrl,
  secret: env.betterAuthSecret,
  basePath: "/api/auth",
  database: prismaAdapter(prisma, { provider: "postgresql" }),

  emailAndPassword: {
    enabled: true,
    // `disableSignUp` is deliberately NOT set here. It would block the endpoint
    // handler itself, and `auth.api.signUpEmail()` runs through that same
    // handler - so it would also break the admin "create agent" flow and the
    // seed script, which are the only two callers we want.
    //
    // Public sign-up is closed off one layer up instead, by `blockPublicSignUp`
    // in app.ts, which 404s the HTTP route before Better Auth ever sees it.
    // In-process calls to auth.api.* bypass Express and still work.
    disableSignUp: false,
    // Creating an agent must not hand the admin that agent's session.
    autoSignIn: false,
  },

  user: {
    additionalFields: {
      /**
       * Server-owned. `input: false` means Better Auth ignores `role` in any
       * request body, so no one can sign themselves up as an ADMIN; the users
       * service sets it directly through Prisma instead.
       */
      role: {
        type: ["ADMIN", "AGENT"],
        required: false,
        defaultValue: "AGENT",
        input: false,
      },
      active: {
        type: "boolean",
        required: false,
        defaultValue: true,
        input: false,
      },
    },
  },

  databaseHooks: {
    session: {
      create: {
        // Runs on every sign-in, before the session row is written. A
        // deactivated user has already had their sessions deleted; this stops
        // them getting a new one with credentials that still work.
        async before(session) {
          const user = await prisma.user.findUnique({
            where: { id: session.userId },
            select: { active: true },
          });

          if (user && !user.active) {
            throw new APIError("FORBIDDEN", {
              message: "This account has been deactivated.",
              code: "ACCOUNT_DEACTIVATED",
            });
          }
        },
      },
    },
  },

  // The Vite dev server. In development the client proxies /api, so this only
  // matters for requests made straight to the API from the browser.
  trustedOrigins: ["http://localhost:5173"],
});
