/**
 * Creates the initial admin account. `project-scope.md`: the system ships with
 * one admin already in place and no self-registration, so this is the only way
 * a first account comes into existence.
 *
 * Idempotent - re-running it against a database that already has the admin
 * reports and exits rather than resetting the password.
 *
 *   bun run db:seed
 */
import { env } from "../src/env.ts";
import { prisma } from "../src/lib/prisma.ts";
import { auth } from "../src/lib/auth.ts";

async function main() {
  const { email, name, password } = env.seedAdmin;

  if (!email || !name || !password) {
    console.error(
      "Set SEED_ADMIN_EMAIL, SEED_ADMIN_NAME and SEED_ADMIN_PASSWORD in server/.env first.",
    );
    process.exit(1);
  }

  const normalisedEmail = email.trim().toLowerCase();

  const existing = await prisma.user.findUnique({
    where: { email: normalisedEmail },
    select: { id: true, role: true },
  });

  if (existing) {
    console.log(`Admin ${normalisedEmail} already exists - nothing to do.`);
    return;
  }

  // Through Better Auth, not Prisma, so the password hash and the credential
  // Account row match what sign-in expects. Public sign-up is blocked at the
  // HTTP layer only, so this in-process call still works - see lib/auth.ts.
  const { user } = await auth.api.signUpEmail({
    body: { name: name.trim(), email: normalisedEmail, password },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { role: "ADMIN" },
  });

  console.log(`Created admin ${normalisedEmail}.`);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
