/**
 * Unit tests for the `ticket.auto-resolve` worker.
 *
 * The handler is three lines of real logic and all three are about what pg-boss
 * does with the result - which is why they are worth pinning: a payload that
 * will never parse must not be retried, and anything the service throws must be
 * left alone so that it *is*. Getting either backwards is invisible until the
 * dead-letter queue fills up or a reply quietly disappears.
 *
 * **Nothing here is faked beyond the usual seams**, and the service underneath
 * is the real one. That rule is not a preference: `mock.module` is
 * process-global, so faking `services/auto-resolve-ticket.ts` here would take
 * the real service away from its own test file - exactly what an earlier version
 * of `classify-ticket.job.test.ts` did, breaking all nineteen tests in a file it
 * never mentioned. Driving the real service costs nothing, because `modelUse`
 * makes it throw and `autoResolveRow` makes it no-op.
 *
 * `batchSize` is the one place this file differs from its sibling, and it is the
 * difference worth having a test for: one, not two.
 */
import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  autoResolveRow,
  autoResolveTicketRow,
  bossUse,
  deciding,
  DEFAULT_AUTO_REPLY,
  failing,
  modelUse,
  openaiEnv,
  resetFakes,
  txUse,
  type BossHandler,
} from "../test/fakes.ts";

const { registerAutoResolveTicketWorker } = await import("./auto-resolve-ticket.job.ts");
const { startQueue, stopQueue } = await import("../lib/queue.ts");

/** Registers the worker and hands back the handler pg-boss would call. */
async function handler(): Promise<BossHandler> {
  await registerAutoResolveTicketWorker();
  // One registration, and only this worker's: `startWorkers()` is what mounts
  // both, and it is not what is under test here.
  expect(bossUse.works).toHaveLength(1);
  return bossUse.works[0]!.handler;
}

/** One job in the shape pg-boss delivers it - a batch, even of one. */
function job(data: unknown, id = "job-1") {
  return { id, data };
}

/** The ticket ids the service resolved, in order. */
function resolvedIds(): number[] {
  return txUse.updateManys.map((args) => (args.where as { id: number }).id);
}

describe("the auto-resolve-ticket worker", () => {
  // The queue and the handler both narrate themselves; right in a server log,
  // noise here.
  const quiet = [spyOn(console, "log"), spyOn(console, "info")];

  afterAll(async () => {
    await stopQueue();
    for (const spy of quiet) spy.mockRestore();
  });

  beforeEach(async () => {
    await stopQueue();
    resetFakes();
    for (const spy of quiet) spy.mockImplementation(() => {});
    // A configured server, or the service answers without reaching the model.
    openaiEnv.apiKey = "sk-unit-test";
    modelUse.model = deciding({ canAnswer: true, reply: DEFAULT_AUTO_REPLY });
    await startQueue();
  });

  it("registers on the auto-resolve queue", async () => {
    await registerAutoResolveTicketWorker();

    expect(bossUse.works[0]!.name).toBe("ticket.auto-resolve");
  });

  /**
   * **One at a time**, against the classifier's two. This is the most expensive
   * call in the system - the whole knowledge base in the prompt, medium
   * reasoning, a written reply out - and the only one that resolves a ticket. A
   * backlog draining steadily is the behaviour to want, and nobody is waiting
   * on it.
   */
  it("takes one job at a time", async () => {
    await registerAutoResolveTicketWorker();

    expect(bossUse.works[0]!.options.batchSize).toBe(1);
  });

  /** Nothing to register on: the caller decided there is no queue. */
  it("does nothing when the queue is not running", async () => {
    await stopQueue();
    await registerAutoResolveTicketWorker();

    expect(bossUse.works).toEqual([]);
  });

  it("auto-resolves the ticket the job names", async () => {
    await (await handler())([job({ ticketId: 42 })]);

    expect(resolvedIds()).toEqual([42]);
    expect(txUse.messages).toHaveLength(1);
  });

  /** pg-boss delivers a batch, and every job in it has to be handled. */
  it("handles every job in a batch", async () => {
    await (await handler())([
      job({ ticketId: 1 }, "a"),
      job({ ticketId: 2 }, "b"),
      job({ ticketId: 3 }, "c"),
    ]);

    expect(resolvedIds()).toEqual([1, 2, 3]);
  });

  /**
   * **The error is left to propagate**, which is how pg-boss knows to retry. A
   * handler that caught this would turn every transient provider failure into a
   * ticket that nobody ever looked at again.
   */
  it("lets a failure reach pg-boss so the job is retried", async () => {
    modelUse.model = failing(new Error("429 Rate limit reached"));

    await expect((await handler())([job({ ticketId: 7 })])).rejects.toThrow();
    expect(txUse.updateManys).toEqual([]);
  });

  /**
   * The opposite case. A payload with no usable id names no ticket and cannot be
   * fixed by trying again, so the job is logged and treated as done rather than
   * retried three times into the dead-letter queue.
   */
  it.each([
    [{ ticketId: "7" }, "a string id"],
    [{ ticketId: 0 }, "zero"],
    [{ ticketId: -1 }, "a negative id"],
    [{ ticketId: 1.5 }, "a fraction"],
    [{}, "no id at all"],
    [null, "no payload"],
  ])("does not retry %p (%s)", async (data) => {
    const logged = spyOn(console, "error").mockImplementation(() => {});

    // Resolves rather than rejects: that is what tells pg-boss not to come back.
    await (await handler())([job(data)]);

    expect(txUse.updateManys).toEqual([]);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  /**
   * A deliberate no-op from the service - here, a ticket an agent has already
   * resolved - is a job well done, not a job to retry. This is the common case
   * in production, since most tickets are not answerable from the knowledge
   * base.
   */
  it("completes quietly when there was nothing to answer", async () => {
    autoResolveRow.ticket = autoResolveTicketRow({ status: "RESOLVED" });

    await (await handler())([job({ ticketId: 7 })]);

    expect(txUse.updateManys).toEqual([]);
    expect(txUse.messages).toEqual([]);
  });

  it("completes quietly when the knowledge base does not answer the ticket", async () => {
    modelUse.model = deciding({ canAnswer: false, reply: "" });

    await (await handler())([job({ ticketId: 7 })]);

    expect(txUse.updateManys).toEqual([]);
  });
});
