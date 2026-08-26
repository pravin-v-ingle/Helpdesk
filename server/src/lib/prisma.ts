import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.ts";
import { env } from "../env.ts";

/**
 * Prisma 7 requires a driver adapter. A single client is shared across the
 * process; `bun --hot` reuses the module, so this is not re-created on reload.
 */
const adapter = new PrismaPg({ connectionString: env.databaseUrl });

export const prisma = new PrismaClient({ adapter });

/** Cheap round trip used by the health endpoint to prove the database is reachable. */
export async function checkDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    console.error("Database health check failed:", err);
    return false;
  }
}
