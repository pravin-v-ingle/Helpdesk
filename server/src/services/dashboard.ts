import { Prisma } from "../generated/prisma/client.ts";
import { TicketStatus } from "../generated/prisma/enums.ts";
import { prisma } from "../lib/prisma.ts";

/**
 * The scalar figures the dashboard's tiles show. Mirrored by `DashboardMetrics`
 * in `client/src/lib/dashboard.ts` - change both together.
 *
 * Two of the six fields exist to keep the other four honest, and both are the
 * point rather than padding:
 *
 * - `averageResolutionSeconds` is `null` rather than `0` when nothing has been
 *   measured. Zero is a resolution time; "no answer yet" is not, and a tile
 *   reading "0m" would be read as instant service.
 * - `measuredResolutions` is the sample the average is over, which is **not**
 *   the number of resolved tickets. `Ticket.resolvedAt` only started being
 *   recorded when the column landed, so every ticket resolved before that
 *   counts towards `totalTickets` and towards nothing else. The page prints the
 *   sample size beside the average instead of quietly averaging over whatever
 *   happens to be left.
 */
export type DashboardMetrics = {
  totalTickets: number;
  openTickets: number;
  /**
   * Tickets the knowledge-base auto-resolver answered, ever - `autoResolvedAt
   * IS NOT NULL`, which a student's reply does not clear. So a ticket it
   * answered and a student then reopened is still counted here while also
   * counting in `openTickets`, and that is deliberate: the question this
   * measures is how much work the auto-resolver took off the queue, and it did
   * take that ticket off it. The two tiles are not meant to partition the total.
   */
  aiResolvedTickets: number;
  /** `aiResolvedTickets` as a percentage of `totalTickets`, to one decimal place. */
  aiResolvedPercent: number;
  /** Mean `resolvedAt - createdAt`, in seconds. Null when nothing is measured. */
  averageResolutionSeconds: number | null;
  measuredResolutions: number;
};

/**
 * One day's arrivals, for the volume chart. `date` is `YYYY-MM-DD`.
 *
 * **The day is a UTC day**, which is the one thing to know before reading the
 * chart. `Ticket.createdAt` is `timestamp(3)` without a zone and Prisma writes
 * UTC into it, so a UTC day is the only bucket that needs no guess about who is
 * looking. The cost is real and worth stating: an agent in Sydney sees a ticket
 * that arrived at 9am local filed under the previous day. Fixing that properly
 * means bucketing in the viewer's zone - a parameter on the request, and a cache
 * key per zone - which is not worth it until somebody is actually bothered.
 */
export type DailyTicketCount = {
  date: string;
  count: number;
};

/** Everything `GET /api/dashboard` returns. */
export type DashboardData = {
  metrics: DashboardMetrics;
  /**
   * Exactly `VOLUME_DAYS` entries, oldest first, ending with today - **including
   * the days nothing arrived**. The zero-fill is `generate_series` in the query
   * rather than a loop here, because a chart that simply omits a quiet day draws
   * a lie: the bars stop being a time axis and become a list of busy days with
   * the gaps closed up.
   */
  dailyVolume: DailyTicketCount[];
};

/** How far the volume chart looks back, today included. */
export const VOLUME_DAYS = 30;

/** What one row of the scalar aggregate looks like coming back off the wire. */
type MetricsRow = {
  total: number;
  open: number;
  aiResolved: number;
  measured: number;
  averageSeconds: number | null;
};

/**
 * Every dashboard figure: five scalars from one aggregate, plus the daily
 * arrivals for the chart.
 *
 * **Two statements, one snapshot.** Both run inside a `RepeatableRead`
 * transaction, which is what stops the tiles disagreeing with the chart - the
 * 30 days must not sum to more tickets than the total says exist, and at
 * read-committed each statement sees its own snapshot, so a ticket arriving
 * between them makes exactly that happen. Repeatable read is enough and
 * serializable is not needed: this reads and never writes, so there is no
 * conflict to retry (`serializable()` in `lib/transaction.ts` exists for
 * check-then-write, which this is not).
 *
 * **Raw SQL rather than Prisma's aggregate API**, which cannot express either
 * query. The scalars need `AVG` over the difference between two columns on the
 * same row; the series needs a `generate_series` left join to zero-fill the
 * quiet days. The alternative to both is pulling rows into the process to
 * reduce them by hand, which moves an unbounded result set across the wire to
 * compute numbers the database is built to compute. `COUNT(*) FILTER` rides
 * along in the first statement because it is free once the scan is happening.
 *
 * The one rule raw SQL must not quietly break is the enum one: `TicketStatus.OPEN`
 * is passed as a bound parameter and cast, never typed as the string `'OPEN'`,
 * so renaming a member in `schema.prisma` is still a compile error here.
 */
export async function getDashboard(): Promise<DashboardData> {
  const metricsQuery = prisma.$queryRaw<MetricsRow[]>`
    SELECT
      COUNT(*)::int                                                      AS "total",
      COUNT(*) FILTER (WHERE "status" = ${TicketStatus.OPEN}::"TicketStatus")::int
                                                                         AS "open",
      COUNT("autoResolvedAt")::int                                       AS "aiResolved",
      COUNT("resolvedAt")::int                                           AS "measured",
      AVG(EXTRACT(EPOCH FROM ("resolvedAt" - "createdAt")))::float8      AS "averageSeconds"
    FROM "Ticket"
  `;

  // `d` is a naive timestamp at UTC midnight and `createdAt` is naive UTC, so
  // the half-open comparison needs no zone arithmetic. `to_char` rather than a
  // bare `::date`, so the value arrives as `YYYY-MM-DD` whatever a driver
  // chooses to do with a `date` column.
  const volumeQuery = prisma.$queryRaw<DailyTicketCount[]>`
    SELECT to_char(d, 'YYYY-MM-DD') AS "date", COUNT(t.id)::int AS "count"
    FROM generate_series(
           (now() AT TIME ZONE 'UTC')::date - MAKE_INTERVAL(days => ${VOLUME_DAYS - 1}),
           (now() AT TIME ZONE 'UTC')::date,
           INTERVAL '1 day'
         ) AS d
    LEFT JOIN "Ticket" t
      ON t."createdAt" >= d AND t."createdAt" < d + INTERVAL '1 day'
    GROUP BY d
    ORDER BY d
  `;

  const [metricsRows, dailyVolume] = await prisma.$transaction(
    [metricsQuery, volumeQuery],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );

  // An aggregate with no GROUP BY always returns exactly one row - zeroes and a
  // null average on an empty table - so the fallback is unreachable rather than
  // a case to handle. It is here so the type does not have to lie.
  const row = metricsRows[0] ?? {
    total: 0,
    open: 0,
    aiResolved: 0,
    measured: 0,
    averageSeconds: null,
  };

  return {
    metrics: {
      totalTickets: row.total,
      openTickets: row.open,
      aiResolvedTickets: row.aiResolved,
      aiResolvedPercent: percent(row.aiResolved, row.total),
      // `AVG` of an empty set is SQL NULL, which is the honest answer and the one
      // the type promises. `Number()` because a driver is free to hand a numeric
      // back as a string, and a string here would reach the client as one.
      averageResolutionSeconds: row.averageSeconds === null ? null : Number(row.averageSeconds),
      measuredResolutions: row.measured,
    },
    dailyVolume: dailyVolume.map((day) => ({ date: day.date, count: Number(day.count) })),
  };
}

/**
 * A share as a percentage, to one decimal place. Rounded here rather than on the
 * client so there is one definition of the figure: two readers of the same number
 * should not be able to disagree about it because one of them rounded differently.
 *
 * `total === 0` is 0, not a division by zero: an empty helpdesk has resolved no
 * tickets automatically, which is a true 0% rather than a missing value - unlike
 * the average above, where there is genuinely nothing to report.
 */
function percent(part: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}
