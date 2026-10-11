import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { DailyTicketCount } from '../lib/dashboard.ts'
import { niceCeiling, TicketVolumeChart } from './TicketVolumeChart.tsx'

/**
 * The chart has no server to mock - it is handed its days - so these tests are
 * about the rules a bar chart can break silently:
 *
 * - a quiet day is a zero bar rather than a missing one;
 * - every bar is the same colour, never shaded by its own height;
 * - every value is reachable without a pointer, through focus and the table;
 * - the bar heights are a true proportion of a clean scale top.
 */
function day(date: string, count: number): DailyTicketCount {
  return { date, count }
}

const days = [
  day('2026-10-06', 4),
  day('2026-10-07', 0),
  day('2026-10-08', 0),
  day('2026-10-09', 11),
  day('2026-10-10', 7),
]

function bars() {
  // Each bar's band is labelled with its day and value, which is also what makes
  // it addressable here by what a screen reader would say.
  return screen.getAllByLabelText(/tickets?$/)
}

describe('TicketVolumeChart', () => {
  it('renders one band per day, including the quiet ones', () => {
    render(<TicketVolumeChart days={days} />)

    // Five bands for five days: the two zero days are present as bands, so a
    // quiet stretch reads as zeroes on the baseline rather than as missing data.
    expect(bars()).toHaveLength(5)
    expect(screen.getByLabelText('Wed, 7 Oct 2026: 0 tickets')).toBeInTheDocument()
  })

  it('paints nothing for a zero day but keeps its hit target', async () => {
    const user = userEvent.setup()
    render(<TicketVolumeChart days={days} />)

    const quiet = screen.getByLabelText('Wed, 7 Oct 2026: 0 tickets')
    // No painted bar - a zero-height div would still catch the eye as a sliver.
    expect(quiet.querySelector('.bg-chart-bar')).toBeNull()

    // The band is still the hit target, so the reader can confirm it is a zero
    // rather than a gap.
    await user.hover(quiet)
    expect(within(quiet).getByRole('tooltip')).toHaveTextContent('0 tickets')
  })

  it('scales bar heights against a clean ceiling, not the peak', () => {
    render(<TicketVolumeChart days={days} />)

    // Peak is 11, so the scale top is 20 and the tallest bar is 55% - the axis
    // then reads 20 / 10 / 0 rather than 11 / 5.5 / 0.
    const peak = screen.getByLabelText('Fri, 9 Oct 2026: 11 tickets')
    expect(peak.querySelector<HTMLElement>('.bg-chart-bar')!.style.height).toBe('55%')

    const smaller = screen.getByLabelText('Tue, 6 Oct 2026: 4 tickets')
    expect(smaller.querySelector<HTMLElement>('.bg-chart-bar')!.style.height).toBe('20%')
  })

  it('gives every bar the same colour, whatever its height', () => {
    render(<TicketVolumeChart days={days} />)

    // One series, one colour. Shading a bar by its own value would re-encode the
    // height as lightness and spend the only free channel saying it twice.
    const painted = document.querySelectorAll('.bg-chart-bar')
    expect(painted).toHaveLength(3)
    for (const bar of painted) expect(bar.className).toContain('bg-chart-bar')
  })

  it('shows the same readout on keyboard focus as on hover', async () => {
    const user = userEvent.setup()
    render(<TicketVolumeChart days={days} />)

    // Tooltips enhance, they never gate: a keyboard reader gets the value too.
    await user.tab()
    const focused = document.activeElement as HTMLElement
    expect(focused).toHaveAttribute('aria-label', 'Tue, 6 Oct 2026: 4 tickets')
    expect(within(focused).getByRole('tooltip')).toHaveTextContent('4 tickets')
  })

  it('carries no legend, because there is only one series', () => {
    render(<TicketVolumeChart days={days} />)

    // The heading and subtitle already name what is plotted; a box with one
    // swatch would restate them and cost space.
    expect(screen.getByRole('region', { name: 'Tickets per day' })).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('prints no value on the bars themselves', () => {
    render(<TicketVolumeChart days={days} />)

    // Thirty printed numbers are chaos and go unread. Before any hover, the only
    // numbers on screen are the axis ticks.
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(screen.getByText('20')).toBeInTheDocument()
    expect(screen.getByText('10')).toBeInTheDocument()
  })

  it('offers a table view carrying every value', async () => {
    const user = userEvent.setup()
    render(<TicketVolumeChart days={days} />)

    await user.click(screen.getByText('Show as table'))
    const table = screen.getByRole('table', { name: 'Tickets received per day (UTC)' })

    // One row per day, the zero days included - the WCAG-clean twin of the chart,
    // which is what makes the hover layer an enhancement rather than the only way
    // to read a value.
    expect(within(table).getAllByRole('row')).toHaveLength(days.length + 1)
    expect(within(table).getByRole('rowheader', { name: 'Fri, 9 Oct 2026' })).toBeInTheDocument()
  })

  it('says the days are UTC, and totals them', () => {
    render(<TicketVolumeChart days={days} />)

    // The subtitle does the legend's job and names the bucket: a UTC day is not
    // the viewer's day everywhere, and the chart should not pretend otherwise.
    expect(screen.getByRole('region', { name: 'Tickets per day' })).toHaveTextContent(
      'Last 5 days (UTC) · 22 tickets in total',
    )
  })

  it('says so rather than drawing an empty axis when nothing arrived', () => {
    render(<TicketVolumeChart days={[day('2026-10-09', 0), day('2026-10-10', 0)]} />)

    expect(screen.getByText('No tickets have arrived in this window.')).toBeInTheDocument()
    expect(document.querySelectorAll('.bg-chart-bar')).toHaveLength(0)
  })

  it('renders an empty window without crashing', () => {
    render(<TicketVolumeChart days={[]} />)

    expect(screen.getByRole('region', { name: 'Tickets per day' })).toHaveTextContent(
      'No days to show.',
    )
    // No table either - there is nothing to put in it.
    expect(screen.queryByText('Show as table')).not.toBeInTheDocument()
  })
})

describe('niceCeiling', () => {
  // Clean means 1, 2, 5 or 10 times a power of ten, so the midpoint tick stays a
  // whole number.
  it.each([
    [0, 2],
    [1, 2],
    [2, 2],
    [3, 5],
    [5, 5],
    [7, 10],
    [11, 20],
    [20, 20],
    [21, 50],
    [60, 100],
    [150, 200],
  ])('takes a peak of %i to a scale top of %i', (peak, expected) => {
    expect(niceCeiling(peak)).toBe(expected)
  })
})
