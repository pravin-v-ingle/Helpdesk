/**
 * The worker process: pg-boss and the job handlers, with no HTTP server.
 *
 * `bun src/worker.ts`, or `bun run worker`. This is the second half of task 4.2
 * and the reason the queue is in Postgres rather than in memory - the API and the
 * worker share nothing but the database, so they scale, restart and fail
 * separately. Run it alongside an API started with `RUN_WORKERS=false`, or don't
 * run it at all and let the API process do both, which is the default and what
 * `bun run dev` gives you.
 *
 * Why bother having it when the API can do the work: AI latency and request
 * latency stop competing, a deploy of the API no longer interrupts a
 * classification halfway through, and a backlog can be drained by starting more
 * of these without touching the thing serving agents.
 */
import { env } from "./env.ts";
import { startWorkers } from "./jobs/index.ts";
import { startQueue, stopQueue } from "./lib/queue.ts";

if (!env.queue.enabled) {
  console.error("Cannot run the worker: the job queue is disabled (QUEUE_ENABLED=false).");
  process.exit(1);
}

if (!env.queue.runWorkers) {
  // `RUN_WORKERS=false` is how an API process is told to leave the jobs alone.
  // A worker process started with it is a misconfiguration that would otherwise
  // sit there consuming nothing, looking healthy.
  console.error("Cannot run the worker: RUN_WORKERS=false in this environment.");
  process.exit(1);
}

await startQueue();
await startWorkers();

console.log(`Worker running (${env.nodeEnv}). Waiting for jobs.`);

let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n${signal} received, finishing jobs in flight.`);
    void stopQueue().then(() => {
      process.exitCode = 0;
    });
  });
}
