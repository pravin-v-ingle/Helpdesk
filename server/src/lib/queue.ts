/**
 * The job queue: pg-boss, which keeps its jobs in the same Postgres the
 * application already uses.
 *
 * This is the decision `tech-stack.md` left open under Background processing and
 * task 4.2 asked for. pg-boss rather than BullMQ or a hosted broker for one
 * reason above the others: **it needs no second piece of infrastructure.** The
 * database is already here, already backed up, already in the deployment story,
 * and a queue that lives in it inherits all of that. The price is that it polls
 * rather than pushes, so a job starts within a second or two instead of
 * instantly - which is exactly the right trade for work nobody is watching.
 *
 * The second reason is the one that shaped the code below: because the jobs are
 * rows in the same database, a job can be enqueued **inside the transaction that
 * creates the work** (`fromPrisma` below). No other queue can do that, and it
 * removes the gap where a process dies after committing a ticket but before
 * telling anyone to classify it.
 *
 * pg-boss owns its own `pgboss` schema and migrates it itself on `start()`.
 * Nothing in `prisma/schema.prisma` describes those tables, `bun run db:migrate`
 * knows nothing about them, and the two never meet.
 */
import { PgBoss, fromPrisma } from "pg-boss";
import type { Prisma } from "../generated/prisma/client.ts";
import { env } from "../env.ts";

/**
 * The queues, by name. A `const` object rather than bare strings for the reason
 * every enum in this codebase is one: the name is written once, and the producer
 * and the consumer cannot disagree about it after a typo.
 *
 * Names are dotted and read subject-first (`ticket.classify`), so related queues
 * sort together once there are more of them.
 */
export const QUEUES = {
  classifyTicket: "ticket.classify",
  autoResolveTicket: "ticket.auto-resolve",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/**
 * How a failed job is retried. One policy for every queue: these belong here
 * rather than on each `send()` because they are a property of the queue, not of
 * one job, and because `createQueue` records them in the database - so a worker
 * started by a different process inherits them without being told.
 *
 * Three attempts with exponential backoff suits what actually fails: a rate
 * limit, a timed-out provider, a model that returned something unparseable. All
 * three are worth trying again in a minute and none is worth trying forever.
 * `expireInSeconds` has to clear the slowest service's own model timeout (30s,
 * the auto-resolver's) with room to spare, or pg-boss would reclaim a job that
 * was still legitimately running.
 *
 * Shared by both queues on purpose, including by `ticket.auto-resolve` - whose
 * three attempts mean up to three paid model calls and three attempts at
 * replying to a student. That is safe rather than careless because of the
 * guarded `updateMany` in `services/auto-resolve-ticket.ts`: the second attempt
 * finds the ticket already RESOLVED and writes nothing. If the cost ever
 * matters, this is the constant to split into a `Record<QueueName, ...>`.
 */
const QUEUE_OPTIONS = {
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 120,
} as const;

/**
 * How long a graceful stop waits for jobs in flight. Longer than the
 * classifier's own 20s model timeout, so a shutdown does not abandon the job it
 * is waiting for; short enough that a container orchestrator's own kill deadline
 * (usually 30s) is not what ends the process.
 *
 * It does *not* clear the auto-resolver's 30s timeout, and that is the deliberate
 * side of the trade: an auto-resolution still mid-call when the process stops is
 * cut short, which loses nothing. Nothing is written until the model has
 * answered, so the job is simply never completed and pg-boss hands it to whoever
 * starts next once it expires. Raising this to cover it would instead put the
 * orchestrator's kill in charge of shutdown, which loses the classifications
 * this timeout exists to protect.
 */
const STOP_TIMEOUT_MS = 25_000;

/**
 * The running instance, or `undefined` when the queue is off or has not started.
 *
 * Module-level rather than passed around, for the same reason `lib/prisma.ts`
 * exports one client: there is one queue per process, and threading it through
 * every caller would buy nothing.
 */
let boss: PgBoss | undefined;

/**
 * Starts pg-boss and creates the queues, or does nothing when
 * `QUEUE_ENABLED=false`.
 *
 * Called once from the process entry point, before the HTTP server listens.
 * Throws if the queue is meant to be running and cannot start - a server that
 * believes it has a queue when it has not would silently drop every job, which is
 * worse than refusing to boot.
 */
export async function startQueue(): Promise<void> {
  if (!env.queue.enabled) {
    console.log(
      "Job queue disabled (QUEUE_ENABLED=false); nothing will be classified or auto-resolved.",
    );
    return;
  }
  if (boss) return;

  const instance = new PgBoss({
    connectionString: env.databaseUrl,
    schema: env.queue.schema,
    // The queue's own pool, deliberately small and separate from Prisma's: a
    // burst of jobs must not be able to starve the API of connections.
    max: 4,
    // Maintenance (archiving completed jobs, expiring stale ones) is on, which
    // is what stops the job table growing without bound. It is cheap and it is
    // the reason not to set `supervise: false` to quieten the logs.
    supervise: true,
  });

  // Attached before `start()`, as pg-boss's own guidance says: these are the
  // background errors - a dropped connection, a maintenance failure - that have
  // no caller to reject. Logged and nothing more; pg-boss recovers by itself.
  instance.on("error", (err) => console.error("Job queue error:", err));

  await instance.start();

  // Required since pg-boss 10: a queue has a row of its own, and `send()` to a
  // queue that does not exist is an error rather than an implicit create. Doing
  // it here means the retry policy above is in the database before any job is.
  for (const name of Object.values(QUEUES)) {
    await instance.createQueue(name, QUEUE_OPTIONS);
  }

  boss = instance;
  console.log(`Job queue started (schema "${env.queue.schema}").`);
}

/**
 * Stops pg-boss, letting jobs in flight finish.
 *
 * `graceful: true` is the whole point of calling this on SIGTERM: a classification
 * halfway through a model call is given its chance to finish and record a
 * category, rather than being killed and left for the retry. The timeout has to
 * clear the model's own 20s clock, or a graceful stop would abandon exactly the
 * job it was trying to protect.
 */
export async function stopQueue(): Promise<void> {
  if (!boss) return;

  const instance = boss;
  boss = undefined;
  try {
    await instance.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
  } catch (err) {
    // Shutdown is not a place to throw: the process is leaving and the jobs are
    // durable, so anything in flight is picked up by whoever starts next.
    console.error("Job queue did not stop cleanly:", err);
  }
}

/** The running instance, for the worker registration in `jobs/`. */
export function queue(): PgBoss | undefined {
  return boss;
}

/**
 * Enqueues a job **inside an existing Prisma transaction**, so the job and the
 * rows it is about commit together or not at all.
 *
 * This is the function that justifies choosing a Postgres-backed queue.
 * `fromPrisma(tx)` hands pg-boss the transaction's own connection - it needs
 * only `$queryRawUnsafe`, which a `TransactionClient` has - so the job row is
 * written by the same transaction as the ticket. Either both are there or
 * neither is, and the window where a process commits a ticket and then dies
 * before mentioning it to anyone does not exist.
 *
 * **It throws, and callers must not catch it.** A failed enqueue should abort the
 * transaction, and in the inbound path that is safe and correct rather than
 * dangerous: the `RawEmail` payload is already stored with `processedAt` null,
 * the route answers 500, the provider retries, and the retry resumes from that
 * stored row once the queue is back. Nothing is lost - it is deferred. Compare
 * what swallowing the error would do: a ticket exists, nobody classifies it, and
 * no record says anything went wrong.
 *
 * Returns `null` when the queue is switched off, which is the one case that is
 * not an error. `send` returning a null id (pg-boss's answer to a job suppressed
 * by a uniqueness policy) is passed through the same way.
 */
export async function enqueueInTransaction<T extends object>(
  tx: Prisma.TransactionClient,
  name: QueueName,
  data: T,
): Promise<string | null> {
  if (!env.queue.enabled) return null;
  if (!boss) {
    // Enabled but not started: a programming error - something enqueued before
    // `startQueue()` ran - and not one to paper over, because the job would
    // vanish.
    throw new Error(`Cannot enqueue "${name}": the job queue has not been started.`);
  }

  return boss.send(name, data, { db: fromPrisma(tx) });
}
