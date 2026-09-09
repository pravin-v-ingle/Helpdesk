import { auth } from "./auth.ts";
import { HttpError } from "../middleware/error-handler.ts";

/**
 * Creating accounts with sign-up switched off.
 *
 * `emailAndPassword.disableSignUp` is true, which makes Better Auth's sign-up
 * endpoint refuse every request - including `auth.api.signUpEmail()`, because
 * that runs through the same handler. There is no server-only bypass. So the
 * two callers that are allowed to create accounts (the seed script and the
 * admin-only POST /api/users) go through the internal adapter instead, which is
 * the same path Better Auth's own admin plugin uses for exactly this reason.
 */

/**
 * The `Account.issuer` value Better Auth writes for email/password logins, and
 * the one it filters on when verifying a password. It comes from the library's
 * internal `createLocalAccountIssuer("credential")`, which is not importable
 * here: Bun installs an isolated `node_modules`, so `@better-auth/core` is not
 * resolvable from our code.
 *
 * `assertSignInWillWork` below re-reads the account through Better Auth's own
 * lookup after every create, so if a future version changes this format we fail
 * loudly at account creation rather than silently producing accounts that
 * cannot sign in.
 */
const CREDENTIAL_ISSUER = "local:credential";

export async function createUserWithPassword(input: {
  name: string;
  email: string;
  password: string;
}): Promise<{ id: string; email: string }> {
  const ctx = await auth.$context;
  await assertPasswordAllowed(input.password);

  const user = await ctx.internalAdapter.createUser(
    { name: input.name, email: input.email, emailVerified: false },
    { method: "admin" },
  );

  await ctx.internalAdapter.linkAccount({
    providerId: "credential",
    issuer: CREDENTIAL_ISSUER,
    accountId: user.id,
    userId: user.id,
    password: await ctx.password.hash(input.password),
  });

  await assertSignInWillWork(user.id);

  return { id: user.id, email: user.email };
}

/**
 * Sets a user's password, creating the credential account if they do not have
 * one yet. Used by the seed script's `--repair` path.
 *
 * Deliberately not exposed through the API: there is no "admin resets an
 * agent's password" endpoint yet, and adding one needs a decision about
 * whether it forces a change on next sign-in.
 */
export async function setUserPassword(userId: string, password: string) {
  const ctx = await auth.$context;
  await assertPasswordAllowed(password);

  const hash = await ctx.password.hash(password);
  const existing = await ctx.internalAdapter.findCredentialAccount(userId);

  if (existing) {
    await ctx.internalAdapter.updatePassword(userId, hash);
  } else {
    await ctx.internalAdapter.linkAccount({
      providerId: "credential",
      issuer: CREDENTIAL_ISSUER,
      accountId: userId,
      userId,
      password: hash,
    });
  }

  await assertSignInWillWork(userId);
}

/**
 * The sign-up endpoint would normally enforce these. Bypassing it means
 * enforcing them here, from the same configuration, rather than not at all.
 */
async function assertPasswordAllowed(password: string) {
  const ctx = await auth.$context;
  const { minPasswordLength, maxPasswordLength } = ctx.password.config;

  if (password.length < minPasswordLength) {
    throw new HttpError(400, `Password must be at least ${minPasswordLength} characters`);
  }
  if (password.length > maxPasswordLength) {
    throw new HttpError(400, `Password must be at most ${maxPasswordLength} characters`);
  }
}

/**
 * Reads the credential account back the way sign-in reads it. Guards against
 * the issuer format above drifting out of step with the library.
 */
async function assertSignInWillWork(userId: string) {
  const ctx = await auth.$context;
  const account = await ctx.internalAdapter.findCredentialAccount(userId);

  if (!account) {
    throw new Error(
      "Created a user whose credential account Better Auth cannot find - the " +
        "issuer format in lib/auth-accounts.ts is out of date with this " +
        "version of better-auth. That user would be unable to sign in.",
    );
  }
}
