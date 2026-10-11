import { useQuery } from '@tanstack/react-query'
import { useId } from 'react'
import { Link } from 'react-router'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { TicketVolumeChart } from '@/components/TicketVolumeChart'
import { ApiError } from '../lib/api.ts'
import {
  dashboardQueryOptions,
  formatDuration,
  type DashboardMetrics,
} from '../lib/dashboard.ts'

const NETWORK_ERROR = 'Could not reach the server. Please try again.'

/**
 * The dashboard, and what `/` shows every signed-in user - the placeholder that
 * greeted them by name is gone, because the nav bar already names them and a
 * landing page should say something about the work. Tasks 7.1 and part of 7.2.
 *
 * Five figures, deliberately: how much there is, how much is left, how much the
 * auto-resolver took off the queue in absolute and relative terms, and how long
 * a ticket takes to resolve - then the one chart, arrivals per day over the last
 * thirty. Tiles first because they answer "where do we stand" and the chart
 * answers "how did we get here", which is the order those questions get asked
 * in. Not admin-gated, for the same reason `/tickets` is not - the state of the
 * queue is everybody's business here.
 *
 * One query feeds both, so the tiles and the chart are always the same snapshot
 * of the database and cannot contradict each other.
 */
export function HomePage() {
  const query = useQuery(dashboardQueryOptions())

  const error = query.error
    ? query.error instanceof ApiError
      ? query.error.message
      : NETWORK_ERROR
    : undefined

  return (
    <main className="flex-1 px-6 py-8">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p className="mb-6 text-sm text-muted-foreground">The state of the queue right now.</p>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {query.data ? (
        // `aria-busy` while a refetch is in flight, rather than dropping back to
        // the skeleton: the figures on screen are a moment old, not absent, and
        // a skeleton flash would throw the layout away to say so.
        <div aria-busy={query.isFetching} className="flex flex-col gap-4">
          <Metrics metrics={query.data.metrics} />
          <TicketVolumeChart days={query.data.dailyVolume} />
        </div>
      ) : (
        // A skeleton promises content is coming, so it gives way to the alert
        // alone once there is nothing left to wait for - the same rule the
        // ticket detail page follows.
        !error && <MetricsSkeleton />
      )}
    </main>
  )
}

/**
 * The five tiles. Three columns from `lg`, which puts the three ticket counts on
 * one row and the two derived figures on the next.
 */
function Metrics({ metrics }: { metrics: DashboardMetrics }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Tile
        label="Total tickets"
        value={metrics.totalTickets.toLocaleString()}
        link={{ to: '/tickets', label: 'View all tickets' }}
      />
      <Tile
        label="Open tickets"
        value={metrics.openTickets.toLocaleString()}
        note={openNote(metrics)}
        link={{ to: '/tickets?status=OPEN', label: 'View open tickets' }}
      />
      {/* No link on this one or the two below, and that is not an oversight:
          the ticket list cannot filter on `autoResolvedAt` or on a resolution
          time, so a link here would land an agent on a list that does not show
          what they clicked. A tile that navigates somewhere unrelated is worse
          than one that does not navigate. */}
      <Tile
        label="Resolved by AI"
        value={metrics.aiResolvedTickets.toLocaleString()}
        note="Answered from the knowledge base and resolved, with nobody reviewing it."
      />
      {/* "AI resolution rate" rather than a second tile also labelled "Resolved
          by AI": two regions need two names, and a parenthesised qualifier is
          not one. The accessible name algorithm concatenates an element's
          children with no separator, so a `<span> (share)</span>` inside the
          heading names the region "Resolved by AI(share)" - which a screen
          reader reads as one word and no test can address by what is on
          screen. */}
      <Tile
        label="AI resolution rate"
        value={`${metrics.aiResolvedPercent}%`}
        note="Of all tickets ever received."
      />
      <Tile
        label="Average resolution time"
        value={
          metrics.averageResolutionSeconds === null
            ? '—'
            : formatDuration(metrics.averageResolutionSeconds)
        }
        note={resolutionNote(metrics)}
      />
    </div>
  )
}

/**
 * "none of 39 yet" rather than "0 of 39": an empty queue is the good outcome and
 * should not read like a missing number.
 */
function openNote({ openTickets, totalTickets }: DashboardMetrics): string {
  if (totalTickets === 0) return 'No tickets have arrived yet.'
  return `${openTickets === 0 ? 'None' : String(openTickets)} of ${totalTickets.toLocaleString()} still need an answer.`
}

/**
 * The sample size, said out loud. It is **not** the number of resolved tickets:
 * `Ticket.resolvedAt` has only been recorded since the column landed, so a
 * ticket resolved before that counts towards the total and towards no average.
 * Printing the figure the mean is over is the difference between a number an
 * agent can trust and one they cannot check.
 */
function resolutionNote({ averageResolutionSeconds, measuredResolutions }: DashboardMetrics): string {
  if (averageResolutionSeconds === null) return 'No resolution has been timed yet.'
  return measuredResolutions === 1
    ? 'Across 1 timed resolution.'
    : `Across ${measuredResolutions.toLocaleString()} timed resolutions.`
}

type TileLink = { to: string; label: string }

/**
 * One figure. A `role="region"` named by its own `<h2>`, so every tile has an
 * accessible name and both test suites can address one by the words on screen
 * rather than by its position in the grid. A heading and paragraphs rather than
 * the `<dl>` the ticket detail page's Details card uses: a named region *inside*
 * a description list would sever the `dt`/`dd` pairing it depends on, and these
 * tiles want to be addressable far more than they want to be a list.
 *
 * Every tile's label is therefore distinct, which is a constraint on the words
 * rather than a detail of this component: two regions sharing a name cannot be
 * told apart by anything an agent or a test can see.
 */
function Tile({
  label,
  value,
  note,
  link,
}: {
  label: string
  value: string
  note?: string
  link?: TileLink
}) {
  const labelId = useId()

  return (
    <Card
      role="region"
      aria-labelledby={labelId}
      className="gap-1 px-(--card-spacing)"
    >
      <h2 id={labelId} className="text-sm font-medium text-muted-foreground">
        {label}
      </h2>
      {/* Proportional figures, not `tabular-nums`: equal-width digits make a
          number like 121 look loose at this size, and nothing here has to line
          up with the tile below it. Tabular belongs on the chart's axis ticks
          and table, where values do align. */}
      <p className="text-3xl font-semibold tracking-tight text-foreground">{value}</p>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      {link && (
        <p>
          <Link to={link.to} className="link text-xs">
            {link.label} →
          </Link>
        </p>
      )}
    </Card>
  )
}

/**
 * The placeholder, shaped like the grid it stands in for so nothing jumps when
 * the response lands. It carries a visually hidden `role="status"` and the
 * shapes beside it are `aria-hidden`, with none of the real tiles' accessible
 * names - so a test waiting for the "Total tickets" region cannot match this.
 */
function MetricsSkeleton() {
  return (
    <div>
      <p role="status" className="sr-only">
        Loading dashboard
      </p>
      <div aria-hidden className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 5 }, (_, i) => (
            <Card key={i} className="gap-2 px-(--card-spacing)">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-8 w-20" />
              <Skeleton className="h-3 w-40" />
            </Card>
          ))}
        </div>
        {/* The chart's block too, so the page does not grow downwards when the
            response lands. */}
        <Card className="gap-2 px-(--card-spacing)">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-56" />
          <Skeleton className="h-40 w-full" />
        </Card>
      </div>
    </div>
  )
}
