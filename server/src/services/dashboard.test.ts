/**
 * Unit tests for the dashboard data.
 *
 * The service is two SQL statements and a little arithmetic, so what is worth
 * pinning is not the counting - Postgres does that - but the places this code
 * decides what a number *means*, and the two structural promises the page is
 * built on:
 *
 * - **Null is not zero.** `AVG` over no rows is SQL NULL, and the service must
 *   pass that through rather than report an average of 0, which a tile would
 *   render as `0m` and an agent would read as instant service.
 * - **A share of nothing is 0%, not NaN.** An empty helpdesk has resolved no
 *   tickets automatically, which is a true zero - the opposite call from the
 *   average above, and the asymmetry is deliberate.
 * - **The enum is a bound value, never a string in the SQL.** This is the one
 *   repo-wide rule raw SQL is able to break silently, so it is asserted against
 *   the query text itself.
 * - **One snapshot for both statements**, or the 30 days could sum to more
 *   tickets than the total says exist.
 * - **The series is zero-filled in SQL**, because a chart that omits a quiet day
 *   closes the gap and stops being a time axis.
 *
 * Seams from `test/fakes.ts`, which owns the `$queryRaw` fake and dispatches its
 * two row sets on the SQL.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { TicketStatus } from "../generated/prisma/enums.ts";
import { queryRaw, queryRawUse, resetFakes, transaction } from "../test/fakes.ts";

// `await import`, not a static import: `mock.module` is not hoisted in Bun, so a
// static import of the module under test can be evaluated before `fakes.ts` has
// finished registering - which binds the real Prisma client and points the test
// at the developer's own database.
const { getDashboard, VOLUME_DAYS } = await import("./dashboard.ts");

/** One row of the scalar aggregate, as the database would hand it back. */
function metricsRow(overrides: Record<string, unknown> = {}) {
  return {
    total: 39,
    open: 33,
    aiResolved: 7,
    measured: 6,
    averageSeconds: 3600,
    ...overrides,
  };
}

/**
 * `VOLUME_DAYS` consecutive days from 2026-09-11, all zero unless a test names
 * one. Walked as real dates rather than formatted from an index, which is how
 * the first draft of this fixture quietly produced `2026-09-40`.
 */
function volumeRows(counts: Record<string, number> = {}) {
  const start = Date.UTC(2026, 8, 11);
  return Array.from({ length: VOLUME_DAYS }, (_, i) => {
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    return { date, count: counts[date] ?? 0 };
  });
}

beforeEach(() => {
  resetFakes();
  queryRawUse.metricsRows = [metricsRow()];
  queryRawUse.volumeRows = volumeRows();
});

describe("getDashboard", () => {
  it("maps the scalar aggregate onto the metrics shape", async () => {
    const { metrics } = await getDashboard();

    expect(metrics).toEqual({
      totalTickets: 39,
      openTickets: 33,
      aiResolvedTickets: 7,
      aiResolvedPercent: 17.9,
      averageResolutionSeconds: 3600,
      measuredResolutions: 6,
    });
  });

  it("reads both statements from one snapshot", async () => {
    await getDashboard();

    // Two queries at read-committed each see their own snapshot, which is how the
    // 30 days come to sum to more tickets than the total claims exist.
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledTimes(1);
    const [, options] = transaction.mock.calls[0]!;
    expect(options).toEqual({ isolationLevel: "RepeatableRead" });
  });

  it("binds the status enum as a value rather than typing it into the SQL", async () => {
    await getDashboard();
    const [metricsCall] = queryRawUse.calls;

    // The rule the rest of the codebase gets for free from Prisma: renaming a
    // member in schema.prisma has to be a compile error here too, which it only
    // is while the member is referenced rather than spelled out.
    expect(metricsCall!.values).toEqual([TicketStatus.OPEN]);
    expect(metricsCall!.sql).not.toContain("'OPEN'");
    expect(metricsCall!.sql).toContain('::"TicketStatus"');
  });

  // --- the volume series ------------------------------------------------------

  it("returns the window oldest first, including the days nothing arrived", async () => {
    queryRawUse.volumeRows = volumeRows({ "2026-09-12": 4, "2026-10-10": 11 });

    const { dailyVolume } = await getDashboard();

    expect(dailyVolume).toHaveLength(VOLUME_DAYS);
    expect(dailyVolume[0]!.date).toBe("2026-09-11");
    expect(dailyVolume[0]!.count).toBe(0);
    expect(dailyVolume[1]!).toEqual({ date: "2026-09-12", count: 4 });
    // A quiet day is a zero bar, not a missing one: dropping it would close the
    // gap and turn the time axis into a list of busy days.
    expect(dailyVolume.filter((d) => d.count === 0)).toHaveLength(VOLUME_DAYS - 2);
  });

  it("asks the database to zero-fill rather than doing it here", async () => {
    await getDashboard();
    const volumeCall = queryRawUse.calls.find((c) => c.sql.includes("generate_series"));

    // The window is a bound value too, so `VOLUME_DAYS` is the single definition
    // of how far back the chart looks.
    expect(volumeCall).toBeDefined();
    expect(volumeCall!.values).toEqual([VOLUME_DAYS - 1]);
    // Bucketed in UTC, deliberately and documented: `createdAt` is naive UTC, so
    // any other bucket needs a guess about who is looking.
    expect(volumeCall!.sql).toContain("AT TIME ZONE 'UTC'");
  });

  it("coerces a count handed back as a string", async () => {
    queryRawUse.volumeRows = [{ date: "2026-10-10", count: "7" }];

    expect((await getDashboard()).dailyVolume[0]).toEqual({ date: "2026-10-10", count: 7 });
  });

  // --- what the numbers mean when there is nothing to report -----------------

  it("reports no average rather than an average of zero", async () => {
    queryRawUse.metricsRows = [metricsRow({ measured: 0, averageSeconds: null })];

    const { metrics } = await getDashboard();

    // Zero is a resolution time; "nothing has been timed" is not.
    expect(metrics.averageResolutionSeconds).toBeNull();
    expect(metrics.measuredResolutions).toBe(0);
  });

  it("reports 0% rather than NaN on an empty helpdesk", async () => {
    queryRawUse.metricsRows = [
      metricsRow({ total: 0, open: 0, aiResolved: 0, measured: 0, averageSeconds: null }),
    ];

    const { metrics } = await getDashboard();

    expect(metrics.aiResolvedPercent).toBe(0);
    expect(Number.isNaN(metrics.aiResolvedPercent)).toBe(false);
  });

  it("rounds the share to one decimal place, in the service", async () => {
    queryRawUse.metricsRows = [metricsRow({ total: 3, aiResolved: 1 })];

    // Rounded here rather than on the client so two readers of the same figure
    // cannot disagree about it because one of them rounded differently.
    expect((await getDashboard()).metrics.aiResolvedPercent).toBe(33.3);
  });

  it("counts an auto-resolved ticket a student reopened, in both tiles", async () => {
    // `autoResolvedAt` survives a reopen, so a ticket can count as resolved by
    // AI and as open at once. The tiles measure two things and are deliberately
    // not a partition of the total.
    queryRawUse.metricsRows = [
      metricsRow({ total: 10, open: 10, aiResolved: 4, measured: 0, averageSeconds: null }),
    ];

    const { metrics } = await getDashboard();

    expect(metrics.openTickets).toBe(10);
    expect(metrics.aiResolvedTickets).toBe(4);
    expect(metrics.aiResolvedPercent).toBe(40);
  });

  // --- the wire ---------------------------------------------------------------

  it("coerces a numeric average handed back as a string", async () => {
    // A driver is free to return `numeric` as a string, and a string reaching the
    // client would be rendered rather than formatted.
    queryRawUse.metricsRows = [metricsRow({ averageSeconds: "1234.5" })];

    const { averageResolutionSeconds } = (await getDashboard()).metrics;

    expect(averageResolutionSeconds).toBe(1234.5);
    expect(typeof averageResolutionSeconds).toBe("number");
  });

  it("lets a database failure through", async () => {
    queryRawUse.error = new Error("connection reset");

    // Nothing to degrade to: a dashboard of invented zeroes is worse than a page
    // that says it could not load, which is what the 500 becomes on the client.
    await expect(getDashboard()).rejects.toThrow("connection reset");
  });
});
