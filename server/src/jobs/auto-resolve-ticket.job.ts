/**
 * The `ticket.auto-resolve` worker: the thin piece between pg-boss and
 * `services/auto-resolve-ticket.ts`.
 *
 * Thin for the reason `classify-ticket.job.ts` is thin, and the two are
 * deliberately near-identical - a reader who knows one knows this one. The
 * service decides what the knowledge base covers and which failures are worth
 * retrying; this file knows only how a job arrives, how its payload is shaped,
 * and that an unrecognisable payload is not worth retrying.
 *
 * Two jobs rather than one doing both this and classification, because they are
 * independent decisions that fail independently: a provider timeout on a reply
 * must not cost the ticket its category, and a model that cannot pick a category
 * has not said anything about whether the knowledge base answers the question.
 */
import type { Job } from "pg-boss";
import { QUEUES, queue } from "../lib/queue.ts";
import { autoResolveTicket } from "../services/auto-resolve-ticket.ts";

/**
 * What goes on the queue: the ticket's id and nothing else, the same claim-on-work
 * shape the classify job uses. The handler re-reads the ticket, so it acts on what
 * the ticket says *now* - which is what lets it notice that an agent has resolved
 * or replied to it since the job was written.
 */
export type AutoResolveTicketJob = { ticketId: number };

/**
 * How many jobs this process handles at once.
 *
 * **One**, against the classifier's two, and the difference is the point. This is
 * the most expensive call in the system - the whole knowledge base in the prompt,
 * `reasoningEffort: "medium"`, a written reply out - and the only one that
 * resolves a ticket and writes to a student. A backlog draining one at a time is
 * the behaviour to want: it bounds the spend, it keeps the concurrent model calls
 * low enough not to be rate limited into the dead-letter queue, and nothing here
 * is latency-sensitive, because nobody is waiting on it.
 */
const CONCURRENCY = 1;

/**
 * Registers the worker on a started queue. Does nothing when there is no queue
 * (`QUEUE_ENABLED=false`) or this process is not meant to run workers
 * (`RUN_WORKERS=false`) - the caller has already decided that.
 */
export async function registerAutoResolveTicketWorker(): Promise<void> {
  const boss = queue();
  if (!boss) return;

  await boss.work<AutoResolveTicketJob>(
    QUEUES.autoResolveTicket,
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
 * One job. A payload that is not a positive integer id names no ticket and cannot
 * be fixed by trying again, so it is logged and treated as done - three attempts
 * at something malformed is three attempts too many. Anything the service throws
 * is left to propagate, which is what earns the job its retry.
 */
async function handle(job: Job<AutoResolveTicketJob>): Promise<void> {
  const { ticketId } = job.data ?? {};

  if (typeof ticketId !== "number" || !Number.isSafeInteger(ticketId) || ticketId < 1) {
    console.error(`Job ${job.id} on ${QUEUES.autoResolveTicket} has no usable ticketId:`, job.data);
    return;
  }

  const reply = await autoResolveTicket(ticketId);
  if (reply) console.log(`Ticket ${ticketId} answered from the knowledge base and resolved.`);
}
