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
    // project-scope.md: "There is no self-registration." This turns the sign-up
    // endpoint off inside Better Auth, so it refuses regardless of how the
    // request reaches it.
    //
    // It is absolute: `auth.api.signUpEmail()` runs through the same handler
    // and is refused too. The seed script and POST /api/users therefore create
    // accounts through lib/auth-accounts.ts, which uses the internal adapter.
    //
    // app.ts also 404s the route in front of Better Auth. That is deliberate
    // duplication - it keeps a closed endpoint from advertising itself, and
    // neither layer depends on the other being present.
    disableSignUp: true,
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
