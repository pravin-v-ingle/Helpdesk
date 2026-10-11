import { useId, useState } from 'react'
import { Card } from '@/components/ui/card'
import type { DailyTicketCount } from '../lib/dashboard.ts'

/**
 * Tickets per day over the window the server sent - the dashboard's one chart.
 * Task 7.3.
 *
 * **Plain HTML and CSS, no chart library.** Thirty bars with a hover readout is
 * a flex row and a percentage height, and the alternative was a charting
 * dependency an order of magnitude larger than the feature. Three things that
 * decided it beyond size: the data-viz mark specs this follows are exact (a 2px
 * gap *in the surface colour* between bars, a 4px radius on the data end only,
 * a hairline solid grid) and are easier to state directly than to coax out of a
 * library's defaults; a `viewBox`'d SVG would scale its own axis text with the
 * card, which is wrong on a narrow screen; and bars as DOM nodes with real
 * `aria-label`s are assertable in jsdom, where SVG path geometry is not. If this
 * becomes the third or fourth chart, revisit - `tech-stack.md` records the call.
 *
 * What the data-viz rules asked for, and where they are kept:
 *
 * - **One series, one colour** - every bar is `--chart-bar`, never shaded by its
 *   own height. A value ramp here would re-encode the bar length as lightness and
 *   spend the only free channel on something the chart already shows.
 * - **No legend.** One series needs none; the heading and subtitle name what is
 *   plotted, and a box with a single swatch would just restate them.
 * - **No number on every bar.** The axis ticks carry the scale, the hover and
 *   focus readout carries the exact day, and the table below carries all of it -
 *   thirty printed values would be unreadable.
 * - **Every value reachable without a pointer.** Each bar takes keyboard focus
 *   and announces itself, and the table view is the full WCAG-clean twin, so the
 *   tooltip only ever enhances.
 * - **A quiet day is a zero-height bar, not a missing one.** The server
 *   zero-fills, and the solid baseline is what makes a run of quiet days read as
 *   zeroes sitting on the axis rather than as data that failed to load.
 */
export function TicketVolumeChart({ days }: { days: DailyTicketCount[] }) {
  const headingId = useId()
  const [active, setActive] = useState<number | null>(null)

  const total = days.reduce((sum, day) => sum + day.count, 0)
  const busiest = days.reduce((max, day) => Math.max(max, day.count), 0)
  const scaleMax = niceCeiling(busiest)

  return (
    <Card
      role="region"
      aria-labelledby={headingId}
      className="gap-1 px-(--card-spacing)"
    >
      <h2 id={headingId} className="text-sm font-medium text-muted-foreground">
        Tickets per day
      </h2>
      {/* The subtitle does the legend's job for a single series, and says which
          day a bar is: a UTC day, which is not the viewer's day everywhere. */}
      <p className="text-xs text-muted-foreground">
        {days.length === 0
          ? 'No days to show.'
          : `Last ${days.length} days (UTC) · ${total.toLocaleString()} ${total === 1 ? 'ticket' : 'tickets'} in total`}
      </p>

      {busiest === 0 ? (
        <p className="py-8 text-sm text-muted-foreground">
          No tickets have arrived in this window.
        </p>
      ) : (
        <div className="mt-3 flex gap-2">
          {/* The y axis: clean numbers only, top and bottom of the scale. Tabular
              figures because these align vertically, which is the one place the
              data-viz rules want them. */}
          <div
            aria-hidden
            className="flex h-40 w-8 shrink-0 flex-col justify-between text-right text-[0.625rem] tabular-nums text-muted-foreground"
          >
            <span>{scaleMax.toLocaleString()}</span>
            <span>{(scaleMax / 2).toLocaleString()}</span>
            <span>0</span>
          </div>

          <div className="min-w-0 flex-1">
            {/* The plot. Gridlines are solid hairlines one step off the surface,
                never dashed - a dashed rule reads as a threshold when it is just
                a grid. The baseline is what a zero-count day sits on. */}
            <div className="relative h-40">
              <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-border" />
              <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-border" />
              <div className="absolute inset-x-0 bottom-0 flex h-40 items-end gap-[2px] border-b border-border">
                {days.map((day, index) => (
                  <Bar
                    key={day.date}
                    day={day}
                    scaleMax={scaleMax}
                    isActive={active === index}
                    onActivate={() => setActive(index)}
                    onDeactivate={() => setActive((current) => (current === index ? null : current))}
                  />
                ))}
              </div>
            </div>

            {/* The x axis, in its own row below the plot rather than overlaid, so
                the card grows to fit it instead of clipping it into a scrollbar.
                Labelled sparsely - thirty dates would collide. */}
            <div aria-hidden className="mt-1.5 flex justify-between text-[0.625rem] text-muted-foreground">
              <span>{days[0] ? shortDate(days[0].date) : ''}</span>
              <span>{days.at(-1) ? shortDate(days.at(-1)!.date) : ''}</span>
            </div>
          </div>
        </div>
      )}

      {/* The table twin. Collapsed, because the chart is the point and thirty
          rows are not - but it is real markup, so every value is reachable with
          no pointer and no hover, which is what stops the tooltip from gating
          anything. */}
      {days.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Show as table
          </summary>
          <div className="mt-2 max-h-56 overflow-y-auto">
            <table className="w-full text-xs">
              <caption className="sr-only">Tickets received per day (UTC)</caption>
              <thead className="sticky top-0 bg-card">
                <tr className="text-muted-foreground">
                  <th scope="col" className="py-1 text-left font-medium">
                    Day
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Tickets
                  </th>
                </tr>
              </thead>
              <tbody>
                {days.map((day) => (
                  <tr key={day.date}>
                    <th scope="row" className="py-1 text-left font-normal">
                      {longDate(day.date)}
                    </th>
                    <td className="py-1 text-right tabular-nums">{day.count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </Card>
  )
}

/**
 * One day's bar, and its own hit target.
 *
 * The whole band is the target, not the painted pixels: a zero-count day paints
 * nothing at all and still has to be hoverable, or the reader cannot tell a
 * quiet day from a gap. Capped at 24px wide so a short window does not produce
 * slabs - the band keeps the leftover as air.
 *
 * `aria-label` rather than a title attribute, and the same readout on focus as
 * on hover, so the value is never pointer-only.
 */
function Bar({
  day,
  scaleMax,
  isActive,
  onActivate,
  onDeactivate,
}: {
  day: DailyTicketCount
  scaleMax: number
  isActive: boolean
  onActivate: () => void
  onDeactivate: () => void
}) {
  const label = `${longDate(day.date)}: ${day.count} ${day.count === 1 ? 'ticket' : 'tickets'}`

  return (
    <div
      className="group relative flex h-full min-w-0 flex-1 items-end justify-center focus:outline-none"
      tabIndex={0}
      aria-label={label}
      onPointerEnter={onActivate}
      onPointerLeave={onDeactivate}
      onFocus={onActivate}
      onBlur={onDeactivate}
    >
      {isActive && (
        <div
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 rounded-md bg-popover px-2 py-1 text-popover-foreground ring-1 ring-foreground/10"
        >
          {/* Value first and strong, date second: the reader already knows which
              bar they are pointing at and wants the number. */}
          <span className="block text-xs font-semibold whitespace-nowrap">
            {day.count.toLocaleString()} {day.count === 1 ? 'ticket' : 'tickets'}
          </span>
          <span className="block text-[0.625rem] whitespace-nowrap text-muted-foreground">
            {longDate(day.date)}
          </span>
        </div>
      )}
      {day.count > 0 && (
        <div
          // 4px radius on the data end only; square where it meets the baseline,
          // because a rounded foot would lift the bar off the axis it is measured
          // from. The gap between bars is surface, not a border.
          className="w-full max-w-6 rounded-t-[4px] bg-chart-bar transition-opacity group-hover:opacity-80 group-focus:opacity-80"
          // Rounded to two places, because the raw ratio reaches the style
          // attribute as `55.00000000000001%` - true, and noise in the DOM.
          style={{ height: `${Math.round((day.count / scaleMax) * 10_000) / 100}%` }}
        />
      )}
    </div>
  )
}

/**
 * The top of the y scale: the smallest clean number at or above the busiest day,
 * and always even so the midpoint tick is a whole number too.
 *
 * Clean means 1, 2, 5 or 10 times a power of ten - so a peak of 11 scales to 20
 * rather than to 11, and the two ticks read 20 / 10 rather than 11 / 5.5.
 */
export function niceCeiling(peak: number): number {
  if (peak <= 0) return 2
  const magnitude = 10 ** Math.floor(Math.log10(peak))
  for (const step of [2, 5, 10]) {
    const candidate = step * magnitude
    if (candidate >= peak) return candidate
  }
  return 10 * magnitude
}

/** `Mon D` - the axis ends, where there is room for very little. */
function shortDate(date: string): string {
  return parseUtcDay(date).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

/** The full day, for a readout and a table row. */
function longDate(date: string): string {
  return parseUtcDay(date).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * `YYYY-MM-DD` as a date. Rendered with `timeZone: 'UTC'` by both formatters
 * above, which matters: the bare string parses as UTC midnight, and formatting
 * *that* in a negative-offset local zone would print the previous day - so the
 * chart would disagree with its own axis about which day a bar is.
 */
function parseUtcDay(date: string): Date {
  return new Date(`${date}T00:00:00Z`)
}
