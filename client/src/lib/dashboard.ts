/**
 * The dashboard API (`/api/dashboard`). Transport stays in `api.ts`; this file
 * knows the endpoint's response shape and its query key.
 *
 * A file of its own rather than a corner of `lib/tickets.ts`, even though every
 * number in it is counted off tickets: the two have no cache key in common, and
 * a write to a ticket must not invalidate the dashboard through
 * `ticketKeys.all`. The same reasoning kept `lib/assignees.ts` out of
 * `lib/users.ts`.
 */
import { queryOptions } from '@tanstack/react-query'
import { apiFetch } from './api.ts'

/**
 * Mirrors `DashboardMetrics` in `server/src/services/dashboard.ts` - change both
 * together.
 *
 * Note the two fields that are not simply counts, because the page has to render
 * both cases rather than pick a number to stand in for "don't know":
 * `averageResolutionSeconds` is null when nothing has been measured, and
 * `measuredResolutions` is how many tickets that average is over - which is not
 * the number of resolved tickets, because tickets resolved before the server
 * started recording `resolvedAt` have no resolution time to average.
 */
export type DashboardMetrics = {
  totalTickets: number
  openTickets: number
  /**
   * Tickets the auto-resolver answered, ever. A student's reply reopens such a
   * ticket without clearing the fact, so one ticket can count here and in
   * `openTickets` at once: these tiles measure two different things and are not
   * meant to add up to the total.
   */
  aiResolvedTickets: number
  /** Already a percentage, already rounded to one decimal place by the server. */
  aiResolvedPercent: number
  /** Mean seconds from a ticket arriving to it being resolved, or null. */
  averageResolutionSeconds: number | null
  measuredResolutions: number
}

/**
 * One day's arrivals. Mirrors `DailyTicketCount` on the server.
 *
 * `date` is `YYYY-MM-DD` and the day is a **UTC** day, which the chart's
 * subtitle says out loud: `Ticket.createdAt` carries no zone, so bucketing in
 * the viewer's own would mean telling the server which zone to use. An agent far
 * from UTC will see a late-evening ticket on the next bar.
 */
export type DailyTicketCount = {
  date: string
  count: number
}

/**
 * Everything `GET /api/dashboard` returns. Two keys because they are two things
 * the page renders separately - the tiles and the chart - read from one database
 * snapshot so they cannot contradict each other.
 */
export type DashboardData = {
  metrics: DashboardMetrics
  /** `VOLUME_DAYS` entries, oldest first, ending today, zero-filled. */
  dailyVolume: DailyTicketCount[]
}

/**
 * One key, because there is one request with no parameters. `all` is what a
 * write would invalidate if anything on the client ever changed a figure here -
 * nothing does today: the page is read-only and the numbers move when mail
 * arrives, not when this app does something.
 */
export const dashboardKeys = {
  all: ['dashboard'] as const,
  data: () => [...dashboardKeys.all, 'data'] as const,
}

export function dashboardQueryOptions() {
  return queryOptions({
    queryKey: dashboardKeys.data(),
    queryFn: ({ signal }) => getDashboard(signal),
  })
}

export function getDashboard(signal?: AbortSignal): Promise<DashboardData> {
  return apiFetch<DashboardData>('/api/dashboard', { signal })
}

/**
 * A duration in seconds as something an agent reads at a glance: `4m`, `2h 15m`,
 * `3d 4h`. Two units at most, and the smaller one dropped when it is zero.
 *
 * It rounds **down** to the unit shown, which is the right direction for a
 * figure people quote at each other: "about 2 hours" overstating as "3h" reads
 * as worse service than was given, while an average of 59 minutes showing as
 * `59m` rather than `1h` is simply true. Under a minute is reported in seconds
 * rather than rounded to `0m`, because a dashboard showing `0m` looks broken
 * even when it is exactly right - and with the auto-resolver answering within
 * seconds of a ticket arriving, that is a real case here rather than a
 * hypothetical one.
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const restMinutes = minutes % 60
    return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`
  }

  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`
}
