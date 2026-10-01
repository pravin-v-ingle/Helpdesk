import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthValue } from '../auth/auth-context.ts'
import { ApiError, apiFetch, Role, type PublicUser } from '../lib/api.ts'
import { TicketCategory, TicketStatus, type Ticket, type TicketListResponse } from '../lib/tickets.ts'
import { TicketsPage } from './TicketsPage.tsx'

// The page is tested down to the request it makes: `apiFetch` is replaced,
// everything above it - the tickets API client, TanStack Query, the router -
// is real. `ApiError` stays real so the page's error handling is exercised.
vi.mock('../lib/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.ts')>()
  return { ...actual, apiFetch: vi.fn() }
})
const mockedApiFetch = vi.mocked(apiFetch)

/**
 * The page is rendered as an **agent**, not an admin. `/tickets` is outside the
 * `RequireRole` branch on purpose - working tickets is the agent's job - and
 * signing the test in as an agent is what would catch an admin-only gate
 * creeping back in.
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

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 1,
    subject: 'Cannot see my enrolment',
    status: TicketStatus.OPEN,
    category: null,
    requesterEmail: 'ada@example.com',
    requesterName: 'Ada Lovelace',
    lastMessageAt: '2026-09-28T09:00:00.000Z',
    createdAt: '2026-09-28T09:00:00.000Z',
    updatedAt: '2026-09-28T09:00:00.000Z',
    messageCount: 1,
    ...overrides,
  }
}

/** Uncategorised, which is every ticket until the Phase 5 classifier runs. */
const unclassified = ticket()

const resolved = ticket({
  id: 2,
  subject: 'Refund for the summer module',
  status: TicketStatus.RESOLVED,
  category: TicketCategory.REFUND_REQUEST,
  requesterEmail: 'cy@example.com',
  requesterName: 'Cy Student',
  lastMessageAt: '2026-09-20T12:00:00.000Z',
  messageCount: 4,
})

const closed = ticket({
  id: 3,
  subject: 'Printer in the lab',
  status: TicketStatus.CLOSED,
  category: TicketCategory.TECHNICAL_QUESTION,
  lastMessageAt: '2026-09-02T08:00:00.000Z',
  messageCount: 2,
})

function listResponse(
  tickets: Ticket[],
  overrides: Partial<Omit<TicketListResponse, 'tickets'>> = {},
): TicketListResponse {
  return { tickets, total: tickets.length, page: 1, pageSize: 20, ...overrides }
}

/** Exposes the router's query string so tests can assert on URL state. */
function LocationSpy() {
  const { search } = useLocation()
  return <span data-testid="location-search">{search}</span>
}

function renderPage(url = '/tickets', user: PublicUser = agent) {
  // `retry: false` so an error test is not waiting on the app client's retry.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const auth: AuthValue = { status: 'authenticated', user, signIn: vi.fn(), signOut: vi.fn() }

  render(
    <QueryClientProvider client={queryClient}>
      <AuthContext value={auth}>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route
              path="/tickets"
              element={
                <>
                  <TicketsPage />
                  <LocationSpy />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthContext>
    </QueryClientProvider>,
  )

  return {
    search: () => screen.getByTestId('location-search').textContent,
    table: () => screen.findByRole('table', { name: 'Tickets' }),
  }
}

/** Paths `apiFetch` was called with, in order. */
function requestedPaths() {
  return mockedApiFetch.mock.calls.map(([path]) => path)
}

function bodyRows(table: HTMLElement) {
  // The first row is the header.
  return within(table).getAllByRole('row').slice(1)
}

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

/**
 * Picks an option in one of the toolbar's Radix selects. Opened from the
 * keyboard: under jsdom the first pointer click after an earlier test's
 * user-event interaction is dropped by the trigger, while ArrowDown opens it
 * every time. The option itself is clicked, which is how Radix selects it.
 */
async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  screen.getByRole('combobox', { name: label }).focus()
  await user.keyboard('{ArrowDown}')
  await user.click(await screen.findByRole('option', { name: option }))
}

describe('TicketsPage', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset()
  })

  it('shows a skeleton until the first response, then the table', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([unclassified, resolved, closed]))
    const page = renderPage()

    // The placeholder is announced, but is not the table a test would wait for.
    expect(screen.getByRole('status')).toHaveTextContent('Loading tickets…')
    expect(screen.queryByRole('table', { name: 'Tickets' })).not.toBeInTheDocument()

    const table = await page.table()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Subject',
      'Requester',
      'Status',
      'Category',
      'Messages',
      'Last message',
    ])

    const rows = bodyRows(table)
    expect(rows).toHaveLength(3)

    const [firstRow, resolvedRow, closedRow] = rows
    expect(within(firstRow!).getByText('Cannot see my enrolment')).toBeInTheDocument()
    expect(within(firstRow!).getByText('Ada Lovelace')).toBeInTheDocument()
    expect(within(firstRow!).getByText('ada@example.com')).toBeInTheDocument()
    expect(within(firstRow!).getByText('Open')).toBeInTheDocument()
    expect(within(firstRow!).getByText('1')).toBeInTheDocument()
    expect(within(firstRow!).getByText(shortDate(unclassified.lastMessageAt))).toHaveAttribute(
      'datetime',
      unclassified.lastMessageAt,
    )

    expect(within(resolvedRow!).getByText('Resolved')).toBeInTheDocument()
    expect(within(resolvedRow!).getByText('Refund request')).toBeInTheDocument()
    expect(within(closedRow!).getByText('Closed')).toBeInTheDocument()
    expect(within(closedRow!).getByText('Technical question')).toBeInTheDocument()
  })

  it('shows an em dash for a ticket no classifier has reached', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([unclassified, resolved]))
    const page = renderPage()

    const [uncategorisedRow, categorisedRow] = bodyRows(await page.table())
    expect(within(uncategorisedRow!).getByText('—')).toBeInTheDocument()
    expect(within(categorisedRow!).queryByText('—')).not.toBeInTheDocument()
  })

  it('requests page 1 of 20 by default and passes the query\'s abort signal', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([unclassified]))
    const page = renderPage()
    await page.table()

    expect(mockedApiFetch).toHaveBeenCalledTimes(1)
    expect(mockedApiFetch).toHaveBeenCalledWith(
      '/api/tickets?page=1&pageSize=20',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('reads its filters from the URL and reflects them in the controls', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([resolved], { total: 3, page: 2, pageSize: 2 }))
    const page = renderPage('/tickets?status=RESOLVED&category=REFUND_REQUEST&page=2&pageSize=2')
    await page.table()

    expect(requestedPaths()).toEqual([
      '/api/tickets?status=RESOLVED&category=REFUND_REQUEST&page=2&pageSize=2',
    ])
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('Resolved')
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveTextContent('Refund request')
  })

  it('reads the Uncategorised filter from the URL', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([unclassified]))
    const page = renderPage('/tickets?category=none')
    await page.table()

    expect(requestedPaths()).toEqual(['/api/tickets?category=none&page=1&pageSize=20'])
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveTextContent('Uncategorised')
  })

  it('normalises URL values the server would refuse', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([unclassified]))
    const page = renderPage('/tickets?status=PENDING&category=BILLING&page=abc&pageSize=999')
    await page.table()

    // Unknown status and category dropped, page defaulted, page size clamped
    // to the server's maximum.
    expect(requestedPaths()).toEqual(['/api/tickets?page=1&pageSize=100'])
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('All statuses')
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveTextContent('All categories')
  })

  it('filters by status through the select and drops the page', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([unclassified]))
    const user = userEvent.setup()
    const page = renderPage('/tickets?page=3')
    await page.table()

    await choose(user, 'Status', 'Open')

    await waitFor(() => expect(page.search()).toBe('?status=OPEN'))
    // The refetch follows the URL change by a render, so it is awaited too -
    // asserting it synchronously here races the query and fails intermittently.
    await waitFor(() =>
      expect(requestedPaths()).toContain('/api/tickets?status=OPEN&page=1&pageSize=20'),
    )
  })

  it('filters by category through the select', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([resolved]))
    const user = userEvent.setup()
    const page = renderPage()
    await page.table()

    await choose(user, 'Category', 'Refund request')

    await waitFor(() => expect(page.search()).toBe('?category=REFUND_REQUEST'))
    await waitFor(() =>
      expect(requestedPaths()).toContain('/api/tickets?category=REFUND_REQUEST&page=1&pageSize=20'),
    )
  })

  it('filters for uncategorised tickets through the select', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([unclassified]))
    const user = userEvent.setup()
    const page = renderPage()
    await page.table()

    await choose(user, 'Category', 'Uncategorised')

    await waitFor(() => expect(page.search()).toBe('?category=none'))
    await waitFor(() =>
      expect(requestedPaths()).toContain('/api/tickets?category=none&page=1&pageSize=20'),
    )
  })

  it('pages with Previous and Next, disabled at the ends', async () => {
    mockedApiFetch.mockImplementation(async (path) => {
      const pageParam = new URL(path, 'http://test').searchParams.get('page')
      return pageParam === '2'
        ? listResponse([closed], { total: 3, page: 2, pageSize: 2 })
        : listResponse([unclassified, resolved], { total: 3, page: 1, pageSize: 2 })
    })
    const user = userEvent.setup()
    const page = renderPage('/tickets?pageSize=2')
    await page.table()

    expect(screen.getByText('Showing 1–2 of 3')).toBeInTheDocument()
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Next' }))

    expect(await screen.findByText('Showing 3–3 of 3')).toBeInTheDocument()
    expect(page.search()).toBe('?pageSize=2&page=2')
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(bodyRows(await page.table())).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Previous' }))

    expect(await screen.findByText('Showing 1–2 of 3')).toBeInTheDocument()
    // Page 1 is stored as absent.
    expect(page.search()).toBe('?pageSize=2')
  })

  it('snaps a page past the end to the last page', async () => {
    mockedApiFetch.mockImplementation(async (path) => {
      const pageParam = new URL(path, 'http://test').searchParams.get('page')
      return pageParam === '99'
        ? listResponse([], { total: 3, page: 99, pageSize: 2 })
        : listResponse([closed], { total: 3, page: 2, pageSize: 2 })
    })
    const page = renderPage('/tickets?page=99&pageSize=2')

    expect(await screen.findByText('Showing 3–3 of 3')).toBeInTheDocument()
    expect(page.search()).toBe('?page=2&pageSize=2')
    expect(requestedPaths()).toEqual([
      '/api/tickets?page=99&pageSize=2',
      '/api/tickets?page=2&pageSize=2',
    ])
  })

  it('tells an empty queue apart from an empty filter result', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([]))

    const unfiltered = renderPage()
    expect(within(await unfiltered.table()).getByText('No tickets yet.')).toBeInTheDocument()
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument()
  })

  it('says so when filters match nothing', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([]))
    const page = renderPage('/tickets?status=CLOSED')

    expect(
      within(await page.table()).getByText('No tickets match your filters.'),
    ).toBeInTheDocument()
  })

  it('keeps the current rows on screen when a page change fails', async () => {
    mockedApiFetch.mockImplementation(async (path) => {
      if (path.includes('page=2')) throw new ApiError(500, 'Internal server error')
      return listResponse([unclassified, resolved], { total: 3, page: 1, pageSize: 2 })
    })
    const user = userEvent.setup()
    const page = renderPage('/tickets?pageSize=2')
    await page.table()

    await user.click(screen.getByRole('button', { name: 'Next' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Internal server error')
    expect(bodyRows(await page.table())).toHaveLength(2)
    expect(screen.getByText('Showing 1–2 of 3')).toBeInTheDocument()
  })

  it('shows the server\'s message when it refuses the request', async () => {
    mockedApiFetch.mockRejectedValue(new ApiError(401, 'Authentication required'))
    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('Authentication required')
    // No data ever arrived, so neither the table nor its placeholder remains.
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows a generic message when the server cannot be reached', async () => {
    mockedApiFetch.mockRejectedValue(new Error('Network Error'))
    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reach the server. Please try again.',
    )
  })
})
