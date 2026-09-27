/**
 * Creates the initial admin account. `project-scope.md`: the system ships with
 * one admin already in place and no self-registration, so this is the only way
 * a first account comes into existence.
 *
 *   bun run db:seed            create the admin, or report if it cannot
 *   bun run db:seed -- --repair   also fix an existing row and reset its password
 *
 * Credentials come from SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in server/.env
 * (SEED_ADMIN_NAME is optional). Nothing is hardcoded here.
 *
 * The plain run never touches an existing account's password, so it is safe to
 * re-run against a live database. `--repair` does change it, which is why it is
 * opt-in.
 */
import { Role } from "../src/generated/prisma/client.ts";
import { env } from "../src/env.ts";
import { prisma } from "../src/lib/prisma.ts";
import {
  createUserWithPassword,
  setUserPassword,
} from "../src/lib/auth-accounts.ts";

const repair = process.argv.includes("--repair");

async function main() {
  const { email, password } = env.seedAdmin;
  const name = env.seedAdmin.name?.trim() || "Admin";

  if (!email || !password) {
    console.error(
      "Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in server/.env first.\n" +
        "See server/.env.example.",
    );
    process.exit(1);
  }

  const normalisedEmail = email.trim().toLowerCase();

  const existing = await prisma.user.findUnique({
    where: { email: normalisedEmail },
    select: { id: true, role: true, active: true, deletedAt: true },
  });

  if (!existing) {
    // Through Better Auth, not Prisma, so the password hash and the credential
    // Account row match what sign-in expects. Sign-up is disabled, so this uses
    // the internal adapter - see lib/auth-accounts.ts.
    const user = await createUserWithPassword({
      name,
      email: normalisedEmail,
      password,
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { role: Role.ADMIN },
    });

    console.log(`Created admin ${normalisedEmail}.`);
    return;
  }

  if (existing.role === Role.ADMIN && existing.active) {
    console.log(`Admin ${normalisedEmail} already exists - nothing to do.`);
    return;
  }

  // The row exists but is not a usable admin - typically left over from earlier
  // testing. Saying "already exists" here would leave someone unable to sign in
  // with no clue why, so this reports the mismatch instead of passing quietly.
  const problems = [
    existing.role !== Role.ADMIN && `its role is ${existing.role}, not ${Role.ADMIN}`,
    // Reported separately from deactivation, which a deleted row also is, so
    // the message says which of the two happened.
    existing.deletedAt !== null && "it has been deleted",
    existing.deletedAt === null && !existing.active && "it is deactivated",
  ].filter(Boolean);

  if (!repair) {
    console.error(
      `${normalisedEmail} already exists, but ${problems.join(" and ")}.\n` +
        "Re-run with --repair to promote it to an active ADMIN and reset its\n" +
        "password to SEED_ADMIN_PASSWORD:\n" +
        "\n    bun run db:seed -- --repair\n",
    );
    process.exit(1);
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: existing.id },
      // `deletedAt` is cleared with `active`, the way `reactivateUser` does it:
      // leaving it set would produce the one state the schema forbids, an
      // account marked deleted that can nonetheless sign in.
      data: { name, role: Role.ADMIN, active: true, deletedAt: null },
    }),
    // Any session it holds was issued under the old role. Drop them so the
    // next sign-in picks the new one up.
    prisma.session.deleteMany({ where: { userId: existing.id } }),
  ]);

  await setUserPassword(existing.id, password);

  console.log(
    `Repaired ${normalisedEmail}: now an active ADMIN, password reset, sessions cleared.`,
  );
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
