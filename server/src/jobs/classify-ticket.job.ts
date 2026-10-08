/**
 * The `ticket.classify` worker: the thin piece between pg-boss and
 * `services/classify-ticket.ts`.
 *
 * It is thin on purpose. The service decides what a category is and which
 * failures are worth retrying; this file knows only how a job arrives, how its
 * payload is shaped, and that an unrecognisable payload is not worth retrying.
 * The same split the routes keep with the services above them.
 */
import type { Job } from "pg-boss";
import { QUEUES, queue } from "../lib/queue.ts";
import { classifyTicket } from "../services/classify-ticket.ts";

/**
 * What goes on the queue: the ticket's id and nothing else.
 *
 * Deliberately not the subject and body as well, though they are to hand when the
 * job is created. A job is a *claim on work*, not a copy of the work's input: the
 * worker re-reads the ticket, so it classifies what the ticket says now rather
 * than what it said when the job was written, and it sees a category an agent set
 * in between. An id is also the only field that cannot go stale.
 */
export type ClassifyTicketJob = { ticketId: number };

/**
 * How many jobs this process handles at once.
 *
 * Two, which is a ceiling on concurrent model calls rather than on throughput:
 * inbound email arrives in ones and twos, and the useful property is that a
 * backlog - a mail loop, a migration, a provider outage clearing all at once -
 * drains steadily instead of opening thirty connections to OpenAI and being rate
 * limited into the dead-letter queue.
 */
const CONCURRENCY = 2;

/**
 * Registers the worker on a started queue. Does nothing when there is no queue
 * (`QUEUE_ENABLED=false`) or this process is not meant to run workers
 * (`RUN_WORKERS=false`) - the caller has already decided that.
 */
export async function registerClassifyTicketWorker(): Promise<void> {
  const boss = queue();
  if (!boss) return;

  await boss.work<ClassifyTicketJob>(
    QUEUES.classifyTicket,
    { batchSize: CONCURRENCY },
    async (jobs) => {
      // pg-boss hands the handler a batch even when the batch is one. Each job is
      // handled in turn rather than in parallel: `batchSize` is already the
      // concurrency limit, and `Promise.all` here would multiply it.
      for (const job of jobs) {
        await handle(job);
      }
    },
  );
}

/**
 * One job. A payload that is not a positive integer id cannot be classified and
 * cannot be fixed by trying again, so it is logged and treated as done - the
 * alternative is three retries and a dead-letter row for something that will
 * never parse. Anything the service throws is left to propagate, which is what
 * earns the job its retry.
 */
async function handle(job: Job<ClassifyTicketJob>): Promise<void> {
  const { ticketId } = job.data ?? {};

  if (typeof ticketId !== "number" || !Number.isSafeInteger(ticketId) || ticketId < 1) {
    console.error(`Job ${job.id} on ${QUEUES.classifyTicket} has no usable ticketId:`, job.data);
    return;
  }

  const category = await classifyTicket(ticketId);
  if (category) console.log(`Ticket ${ticketId} classified as ${category}.`);
}
