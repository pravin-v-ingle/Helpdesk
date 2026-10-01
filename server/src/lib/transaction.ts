/**
 * Serializable transactions, with the retry a serializable transaction needs.
 *
 * Lives in `lib/` because more than one service needs the same guarantee: the
 * users service reads a count and writes on the strength of it, and the inbound
 * email service looks for a parent message and creates a ticket when there is
 * none. Both are "check, then write" against rows another request may be
 * touching at the same moment.
 */
import { Prisma } from "../generated/prisma/client.ts";
import { prisma } from "./prisma.ts";

/**
 * Postgres refused to commit because a concurrent transaction got there first
 * (SQLSTATE 40001). Prisma reports it two ways: as `P2034` on the classic
 * path, and through the driver adapter as a `DriverAdapterError` whose cause
 * is `TransactionWriteConflict` - the form `@prisma/adapter-pg` produces
 * almost every time.
 */
export function isSerializationFailure(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code === "P2034";
  if (err instanceof Error && err.name === "DriverAdapterError") {
    const cause = err.cause as { kind?: string } | undefined;
    return cause?.kind === "TransactionWriteConflict";
  }
  return false;
}

export const SERIALIZABLE_ATTEMPTS = 3;

/**
 * Runs `fn` in a serializable transaction, so a check it makes (an admin
 * count, say) still holds when its write commits. Postgres aborts one side
 * of a conflict rather than letting both through; that side is retried.
 */
export async function serializable<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (err) {
      if (!isSerializationFailure(err) || attempt >= SERIALIZABLE_ATTEMPTS) throw err;
    }
  }
}
