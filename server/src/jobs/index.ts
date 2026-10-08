/**
 * Worker registration: the one place that knows which queues this process
 * consumes.
 *
 * Separate from `lib/queue.ts` on purpose, and the separation is the same one the
 * email adapters needed. `lib/queue.ts` owns the pg-boss instance and is imported
 * by the services that *enqueue*; the handlers import those services. Registering
 * the handlers from inside `lib/queue.ts` would make the queue depend on the
 * services that depend on it, which is the import cycle
 * `lib/email/providers.ts` exists to avoid - and it would pull every job handler
 * into any process that only wanted to send.
 */
import { env } from "../env.ts";
import { registerClassifyTicketWorker } from "./classify-ticket.job.ts";

/**
 * Starts the workers, unless this process is only meant to enqueue.
 *
 * `RUN_WORKERS=false` on the API plus `bun src/worker.ts` elsewhere is how the two
 * are split; one process doing both is the default and is what `bun run dev`
 * gives. Called after `startQueue()`.
 */
export async function startWorkers(): Promise<void> {
  if (!env.queue.enabled) return;
  if (!env.queue.runWorkers) {
    console.log("Not running job workers in this process (RUN_WORKERS=false).");
    return;
  }

  await registerClassifyTicketWorker();
  console.log("Job workers registered.");
}
