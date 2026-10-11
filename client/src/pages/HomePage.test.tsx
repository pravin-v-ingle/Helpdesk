import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthValue } from '../auth/auth-context.ts'
import { ApiError, apiFetch, Role, type PublicUser } from '../lib/api.ts'
import {
  formatDuration,
  type DashboardData,
  type DashboardMetrics,
  type DailyTicketCount,
} from '../lib/dashboard.ts'
import { HomePage } from './HomePage.tsx'

// Only `apiFetch` is replaced: the dashboard API client, TanStack Query and the
// router all run for real, which is what lets a test assert the exact path the
// page asks for. `ApiError` stays real so the refusal branch is exercised.
vi.mock('../lib/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.ts')>()
  return { ...actual, apiFetch: vi.fn() }
})
const mockedApiFetch = vi.mocked(apiFetch)

/**
 * Rendered as an **agent**. `/` is outside the `RequireRole` branch and the
 * endpoint behind it has no role check either, so signing the test in as an
 * agent is what would catch an admin-only gate creeping in.
 */
const agent: PublicUser = {
  id: 'user-agent',
  name: 'Bob Agent',
  email: 'bob@example.com',
  role: Role.AGENT,
  active: true,
  deletedAt: null,
  createdAt: '2026-09-10T10:00:00.000Z',
  updatedAt: '2026-09-10T10:00:00.000Z',
}

function metrics(overrides: Partial<DashboardMetrics> = {}): DashboardMetrics {
  return {
    totalTickets: 120,
    openTickets: 34,
    aiResolvedTickets: 30,
    aiResolvedPercent: 25,
    averageResolutionSeconds: 9000,
    measuredResolutions: 86,
    ...overrides,
  }
}

/** Three consecutive days, enough for the chart to render without being the subject. */
const days: DailyTicketCount[] = [
  { date: '2026-10-08', count: 2 },
  { date: '2026-10-09', count: 0 },
  { date: '2026-10-10', count: 5 },
]

/** The whole response, which is `{ metrics, dailyVolume }` - two keys, one snapshot. */
function dashboard(overrides: Partial<DashboardMetrics> = {}): DashboardData {
  return { metrics: metrics(overrides), dailyVolume: days }
}

function renderPage(user: PublicUser = agent) {
  // `retry: false` so the error test is not waiting on the app client's retry.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const auth: AuthValue = { status: 'authenticated', user, signIn: vi.fn(), signOut: vi.fn() }

  render(
    <QueryClientProvider client={queryClient}>
      <AuthContext value={auth}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<HomePage />} />
          </Routes>
        </MemoryRouter>
      </AuthContext>
    </QueryClientProvider>,
  )
}

/** A tile by the label it shows, which is also its accessible name. */
function tile(name: string) {
  return screen.findByRole('region', { name })
}

/** Paths `apiFetch` was called with, in order. */
function requestedPaths() {
  return mockedApiFetch.mock.calls.map(([path]) => path)
}

beforeEach(() => {
  mockedApiFetch.mockReset()
})

describe('HomePage', () => {
  it('shows a loading placeholder that is not the content, then the tiles', async () => {
    mockedApiFetch.mockResolvedValue(dashboard())
    renderPage()

    // The skeleton announces itself but carries none of the tiles' accessible
    // names, so the wait below cannot be satisfied by the placeholder.
    expect(screen.getByRole('status')).toHaveTextContent('Loading dashboard')
    expect(screen.queryByRole('region', { name: 'Total tickets' })).not.toBeInTheDocument()

    expect(await tile('Total tickets')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('asks for the metrics once, with no parameters', async () => {
    mockedApiFetch.mockResolvedValue(dashboard())
    renderPage()
    await tile('Total tickets')

    expect(requestedPaths()).toEqual(['/api/dashboard'])
  })

  it('renders all five figures', async () => {
    mockedApiFetch.mockResolvedValue(dashboard())
    renderPage()

    expect(within(await tile('Total tickets')).getByText('120')).toBeInTheDocument()
    expect(within(await tile('Open tickets')).getByText('34')).toBeInTheDocument()
    expect(within(await tile('Resolved by AI')).getByText('30')).toBeInTheDocument()
    // Its own label rather than a qualified "Resolved by AI": two regions
    // sharing a name cannot be told apart by what is on screen.
    expect(within(await tile('AI resolution rate')).getByText('25%')).toBeInTheDocument()
    // Formatted the way the page does it rather than hardcoded.
    expect(
      within(await tile('Average resolution time')).getByText(formatDuration(9000)),
    ).toBeInTheDocument()
  })

  it('says how many resolutions the average is over, because it is not the resolved count', async () => {
    mockedApiFetch.mockResolvedValue(dashboard({ measuredResolutions: 86 }))
    renderPage()

    expect(await tile('Average resolution time')).toHaveTextContent('Across 86 timed resolutions.')
  })

  it('shows a dash rather than a zero when no resolution has been timed', async () => {
    mockedApiFetch.mockResolvedValue(
      dashboard({ averageResolutionSeconds: null, measuredResolutions: 0 }),
    )
    renderPage()

    const average = await tile('Average resolution time')
    expect(within(average).getByText('—')).toBeInTheDocument()
    expect(average).toHaveTextContent('No resolution has been timed yet.')
    // A zero here would read as instant service rather than as no data.
    expect(within(average).queryByText('0s')).not.toBeInTheDocument()
  })

  it('reads None rather than 0 when nothing is open', async () => {
    mockedApiFetch.mockResolvedValue(dashboard({ openTickets: 0, totalTickets: 120 }))
    renderPage()

    expect(await tile('Open tickets')).toHaveTextContent('None of 120 still need an answer.')
  })

  it('renders an empty helpdesk without inventing figures', async () => {
    mockedApiFetch.mockResolvedValue({
      metrics: metrics({
        totalTickets: 0,
        openTickets: 0,
        aiResolvedTickets: 0,
        aiResolvedPercent: 0,
        averageResolutionSeconds: null,
        measuredResolutions: 0,
      }),
      dailyVolume: days.map((day) => ({ ...day, count: 0 })),
    })
    renderPage()

    expect(within(await tile('Total tickets')).getByText('0')).toBeInTheDocument()
    expect(await tile('Open tickets')).toHaveTextContent('No tickets have arrived yet.')
    // 0 of 0 is 0%, not a division by zero shown as NaN.
    expect(within(await tile('AI resolution rate')).getByText('0%')).toBeInTheDocument()
  })

  it('renders the volume chart below the tiles', async () => {
    mockedApiFetch.mockResolvedValue(dashboard())
    renderPage()

    // Its own region, fed from the same response as the tiles - one request, so
    // the two can never show different snapshots of the database.
    const chart = await tile('Tickets per day')
    expect(chart).toHaveTextContent('Last 3 days (UTC)')
    expect(requestedPaths()).toEqual(['/api/dashboard'])
  })

  it('links the two tiles the ticket list can actually filter, and no others', async () => {
    mockedApiFetch.mockResolvedValue(dashboard())
    renderPage()
    await tile('Total tickets')

    expect(screen.getByRole('link', { name: /View all tickets/ })).toHaveAttribute(
      'href',
      '/tickets',
    )
    expect(screen.getByRole('link', { name: /View open tickets/ })).toHaveAttribute(
      'href',
      '/tickets?status=OPEN',
    )
    // The list cannot filter on `autoResolvedAt` or on a resolution time, so the
    // other three tiles deliberately go nowhere.
    expect(screen.getAllByRole('link')).toHaveLength(2)
  })

  it('shows a refusal from the server as it arrived, with no skeleton left behind', async () => {
    mockedApiFetch.mockRejectedValue(new ApiError(403, 'Forbidden'))
    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('Forbidden')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Total tickets' })).not.toBeInTheDocument()
  })

  it('shows one sentence when the server was never reached', async () => {
    mockedApiFetch.mockRejectedValue(new Error('network down'))
    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reach the server. Please try again.',
    )
  })
})

describe('formatDuration', () => {
  // Under a minute is reported in seconds: with the auto-resolver answering
  // within seconds of a ticket arriving, a rounded `0m` would be a real and
  // misleading result here rather than a hypothetical one.
  it.each([
    [0, '0s'],
    [45, '45s'],
    [59.9, '59s'],
    [60, '1m'],
    [3599, '59m'],
    [3600, '1h'],
    [9000, '2h 30m'],
    [86399, '23h 59m'],
    [86400, '1d'],
    [187200, '2d 4h'],
  ])('formats %i seconds as %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected)
  })
})
