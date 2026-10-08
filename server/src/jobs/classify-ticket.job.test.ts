/**
 * Unit tests for the `ticket.classify` worker.
 *
 * The handler is three lines of real logic and all three are about what pg-boss
 * does with the result, which is why they are worth pinning: a payload that will
 * never parse must not be retried, and anything the service throws must be left
 * alone so that it *is*. Getting either backwards is invisible until the
 * dead-letter queue fills up or a classification quietly disappears.
 *
 * **Nothing here is faked beyond the usual seams.** The queue is real with the
 * pg-boss fake underneath it, and the service is the real service with the model
 * and the ticket read replaced - all from `test/fakes.ts`. An earlier version of
 * this file faked `services/classify-ticket.ts` itself and, because `mock.module`
 * is process-global, took the real service away from its own test file and broke
 * all nineteen tests in it. Hence the rule `test/fakes.ts` states: a module is
 * faked in exactly one place, and a module another file *tests* is not faked at
 * all.
 *
 * Driving the real service costs nothing here. `modelUse` makes it throw,
 * `classifyRow` makes it no-op, and the handler's behaviour is visible either way.
 */
import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { TicketCategory } from "../generated/prisma/enums.ts";
import {
  bossUse,
  choosing,
  classifyRow,
  failing,
  modelUse,
  openaiEnv,
  resetFakes,
  ticketFindUnique,
  ticketUpdateMany,
  type BossHandler,
} from "../test/fakes.ts";

const { registerClassifyTicketWorker } = await import("./classify-ticket.job.ts");
const { startQueue, stopQueue } = await import("../lib/queue.ts");

/** Registers the worker and hands back the handler pg-boss would call. */
async function handler(): Promise<BossHandler> {
  await registerClassifyTicketWorker();
  expect(bossUse.works).toHaveLength(1);
  return bossUse.works[0]!.handler;
}

/** One job in the shape pg-boss delivers it - a batch, even of one. */
function job(data: unknown, id = "job-1") {
  return { id, data };
}

/** The ticket ids the service was asked to read, in order. */
function readIds(): number[] {
  return ticketFindUnique.mock.calls.map(
    ([args]) => (args as { where: { id: number } }).where.id,
  );
}

describe("the classify-ticket worker", () => {
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
    modelUse.model = choosing(TicketCategory.TECHNICAL_QUESTION);
    await startQueue();
  });

  it("registers on the classify queue", async () => {
    await registerClassifyTicketWorker();

    expect(bossUse.works[0]!.name).toBe("ticket.classify");
  });

  /**
   * A ceiling on concurrent model calls, so a backlog drains steadily instead of
   * opening a connection per job and being rate limited into the dead-letter
   * queue.
   */
  it("limits how many jobs it takes at once", async () => {
    await registerClassifyTicketWorker();

    expect(bossUse.works[0]!.options.batchSize).toBe(2);
  });

  /** Nothing to register on: the caller decided there is no queue. */
  it("does nothing when the queue is not running", async () => {
    await stopQueue();
    await registerClassifyTicketWorker();

    expect(bossUse.works).toEqual([]);
  });

  it("classifies the ticket the job names", async () => {
    await (await handler())([job({ ticketId: 42 })]);

    expect(readIds()).toEqual([42]);
    expect(ticketUpdateMany).toHaveBeenCalledTimes(1);
  });

  /** pg-boss delivers a batch, and every job in it has to be handled. */
  it("handles every job in a batch", async () => {
    await (await handler())([
      job({ ticketId: 1 }, "a"),
      job({ ticketId: 2 }, "b"),
      job({ ticketId: 3 }, "c"),
    ]);

    expect(readIds()).toEqual([1, 2, 3]);
  });

  /**
   * **The error is left to propagate**, which is how pg-boss knows to retry. A
   * handler that caught this would turn every transient provider failure into a
   * classification silently lost.
   */
  it("lets a failure reach pg-boss so the job is retried", async () => {
    modelUse.model = failing(new Error("429 Rate limit reached"));

    await expect((await handler())([job({ ticketId: 7 })])).rejects.toThrow();
    expect(ticketUpdateMany).not.toHaveBeenCalled();
  });

  /**
   * The opposite case. A payload with no usable id cannot be classified and
   * cannot be fixed by trying again, so the job is logged and treated as done
   * rather than retried three times into the dead-letter queue.
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

    expect(ticketFindUnique).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  /**
   * A deliberate no-op from the service - here, a ticket an agent has already
   * categorised - is a job well done, not a job to retry.
   */
  it("completes quietly when there was nothing to classify", async () => {
    classifyRow.ticket = {
      subject: "Cannot see my enrolment",
      body: "I cannot see my enrolment.",
      category: TicketCategory.GENERAL_QUESTION,
    };

    await (await handler())([job({ ticketId: 7 })]);

    expect(readIds()).toEqual([7]);
    expect(ticketUpdateMany).not.toHaveBeenCalled();
  });
});
