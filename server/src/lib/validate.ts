import type { ZodType } from "zod";
import { HttpError } from "../middleware/error-handler.ts";

/**
 * Parses a request body against one of the shared schemas in `@helpdesk/core`.
 * The first issue becomes a 400 carrying that issue's message - the same
 * message the client form shows for the same mistake, because it is the same
 * schema. Routes call this and pass the typed result to a service; they never
 * inspect the body themselves.
 */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(400, result.error.issues[0]?.message ?? "Invalid request body");
  }
  return result.data;
}
