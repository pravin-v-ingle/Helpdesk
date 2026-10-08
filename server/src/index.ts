import { createApp } from "./app.ts";
import { env } from "./env.ts";
import { startWorkers } from "./jobs/index.ts";
import { startQueue, stopQueue } from "./lib/queue.ts";

// The queue starts before the server listens, so no request can be accepted by a
// process that cannot enqueue the work that request creates. `startQueue` throws
// if the queue is meant to be running and cannot start - better to fail to boot
// than to answer webhooks and silently drop every classification.
await startQueue();
await startWorkers();

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(`API listening on http://localhost:${env.port} (${env.nodeEnv})`);
});

/**
 * Shutdown, in the order that loses the least work: stop accepting requests,
 * then let the jobs in flight finish.
 *
 * The queue goes second on purpose. A classification already running is given its
 * 25 seconds to land a category, and `stopQueue` never throws - the jobs are rows
 * in Postgres, so anything genuinely unfinished is picked up by whichever process
 * starts next. `exitCode` rather than `process.exit()`, so a stop that takes a
 * moment is not cut short by the exit itself.
 */
let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // A second Ctrl-C while the first is still draining should not start a
    // second shutdown.
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n${signal} received, shutting down.`);
    server.close(() => {
      void stopQueue().then(() => {
        process.exitCode = 0;
      });
    });
  });
}
