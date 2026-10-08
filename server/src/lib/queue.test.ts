/**
 * Unit tests for the queue wrapper.
 *
 * What is worth testing here is **not** pg-boss - that is somebody else's test
 * suite - but the three decisions this module makes on top of it, each of which
 * would be a silent data-loss bug if it went the other way:
 *
 * 1. A disabled queue returns `null` rather than throwing. It is a configuration,
 *    and it is how the e2e stack runs.
 * 2. An *enabled but unstarted* queue throws. The job would otherwise evaporate
 *    with nothing to say so.
 * 3. An enqueue is handed the transaction's own connection, so the job row commits
 *    with the ticket. This is the whole reason pg-boss was chosen over a broker,
 *    and nothing else in the codebase would notice if it regressed to a separate
 *    connection.
 *
 * The pg-boss fake and the movable `env` both come from `test/fakes.ts`. They are
 * registered there rather than here because `mock.module` is process-global: an
 * `env` fake registered in this file took the one the classifier's tests rely on
 * away from them, and broke twenty-eight tests in another file.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  boss,
  bossUse,
  fromPrisma,
  PRISMA_EXECUTOR,
  queueEnv,
  resetFakes,
} from "../test/fakes.ts";

const { QUEUES, enqueueInTransaction, startQueue, stopQueue, queue } = await import("./queue.ts");

/** Stands in for a `Prisma.TransactionClient`; only its identity is used. */
const tx = { $queryRawUnsafe: async () => [] } as never;

describe("the job queue", () => {
  // This module narrates its own lifecycle, which is right in a server log and
  // noise in a test run - including the one deliberate "did not stop cleanly".
  const quiet = [spyOn(console, "log"), spyOn(console, "error")];

  beforeAll(() => {
    for (const spy of quiet) spy.mockImplementation(() => {});
  });

  afterAll(async () => {
    await stopQueue();
    for (const spy of quiet) spy.mockRestore();
  });

  beforeEach(async () => {
    // The module holds a started instance between tests, so it is stopped before
    // the fakes are reset rather than after.
    await stopQueue();
    resetFakes();
  });

  describe("startQueue", () => {
    it("starts pg-boss and creates every queue", async () => {
      await startQueue();

      expect(queue()).toBeDefined();
      // Every queue in `QUEUES`, so adding one cannot be half-done: created here,
      // or `send` to it is an error.
      expect(bossUse.created).toEqual(Object.values(QUEUES));
    });

    /**
     * The retry policy lives in the database, which is what lets a worker in
     * another process inherit it without being told.
     */
    it("records the retry policy on the queue", async () => {
      await startQueue();

      const options = boss.createQueue.mock.calls[0]![1] as Record<string, unknown>;
      expect(options.retryLimit).toBe(3);
      expect(options.retryBackoff).toBe(true);
      // Has to clear the classifier's own 20s model timeout, or pg-boss would
      // reclaim a job that was still legitimately running.
      expect(options.expireInSeconds as number).toBeGreaterThan(20);
    });

    it("does nothing when the queue is disabled", async () => {
      queueEnv.enabled = false;
      await startQueue();

      expect(queue()).toBeUndefined();
      expect(bossUse.created).toEqual([]);
    });

    /**
     * A server that believed it had a queue when it had not would drop every job
     * silently, so failing to boot is the better outcome.
     */
    it("throws when pg-boss cannot start", async () => {
      bossUse.startError = new Error("ECONNREFUSED");

      await expect(startQueue()).rejects.toThrow("ECONNREFUSED");
      expect(queue()).toBeUndefined();
    });
  });

  describe("enqueueInTransaction", () => {
    /**
     * The point of the whole module. `fromPrisma(tx)` is passed as `send`'s `db`
     * option, so the job row is written by the transaction that created the
     * ticket - either both commit or neither does.
     */
    it("sends the job through the transaction's own connection", async () => {
      await startQueue();

      const id = await enqueueInTransaction(tx, QUEUES.classifyTicket, { ticketId: 7 });

      expect(id).toBe("job-id");
      expect(fromPrisma).toHaveBeenCalledWith(tx);
      expect(bossUse.sends).toEqual([
        {
          name: QUEUES.classifyTicket,
          data: { ticketId: 7 },
          options: { db: PRISMA_EXECUTOR },
        },
      ]);
    });

    /** Off is a configuration, not a failure - the e2e stack runs this way. */
    it("returns null and sends nothing when the queue is disabled", async () => {
      queueEnv.enabled = false;
      await startQueue();

      expect(await enqueueInTransaction(tx, QUEUES.classifyTicket, { ticketId: 7 })).toBeNull();
      expect(bossUse.sends).toEqual([]);
    });

    /**
     * Enabled but unstarted is a programming error - something enqueued before
     * `startQueue()` - and the job would vanish, so it must not be papered over.
     */
    it("throws when the queue is enabled but not started", async () => {
      await expect(
        enqueueInTransaction(tx, QUEUES.classifyTicket, { ticketId: 7 }),
      ).rejects.toThrow(/has not been started/);
    });
  });

  describe("stopQueue", () => {
    it("stops gracefully, giving jobs in flight time to finish", async () => {
      await startQueue();
      await stopQueue();

      const options = boss.stop.mock.calls[0]![0] as Record<string, unknown>;
      expect(options.graceful).toBe(true);
      // Longer than the model's own 20s clock, or a graceful stop would abandon
      // the very job it is waiting for.
      expect(options.timeout as number).toBeGreaterThan(20_000);
      expect(queue()).toBeUndefined();
    });

    /** Shutdown is not a place to throw: the jobs are durable either way. */
    it("swallows a failure to stop", async () => {
      await startQueue();
      bossUse.stopError = new Error("already closed");

      await stopQueue();
      expect(queue()).toBeUndefined();
    });

    it("does nothing when there is no queue", async () => {
      await stopQueue();
      expect(boss.stop).not.toHaveBeenCalled();
    });
  });
});
