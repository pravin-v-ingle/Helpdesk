import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthValue } from '../auth/auth-context.ts'
import { ApiError, apiFetch, Role, type PublicUser } from '../lib/api.ts'
import {
  MessageDirection,
  TicketCategory,
  TicketStatus,
  type TicketDetail,
  type TicketMessage,
} from '../lib/tickets.ts'
import { TicketDetailPage } from './TicketDetailPage.tsx'

// As on the list page: `apiFetch` is replaced and everything above it - the
// tickets API client, TanStack Query, the router - is real, so the test asserts
// the exact request the page builds. `ApiError` stays real.
vi.mock('../lib/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.ts')>()
  return { ...actual, apiFetch: vi.fn() }
})
const mockedApiFetch = vi.mocked(apiFetch)

/** An agent, not an admin: `/tickets/:id` is outside the `RequireRole` branch. */
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

function message(overrides: Partial<TicketMessage> = {}): TicketMessage {
  return {
    id: 10,
    direction: MessageDirection.INBOUND,
    fromEmail: 'ada@example.com',
    fromName: 'Ada Lovelace',
    body: 'I cannot see my enrolment.',
    createdAt: '2026-09-28T09:00:00.000Z',
    ...overrides,
  }
}

const reply = message({
  id: 11,
  direction: MessageDirection.OUTBOUND,
  fromEmail: 'support@example.edu',
  fromName: 'Bob Agent',
  body: 'Thanks for writing in.\nI have had a look.',
  createdAt: '2026-09-28T11:30:00.000Z',
})

function detail(overrides: Partial<TicketDetail> = {}): TicketDetail {
  const messages = overrides.messages ?? [message(), reply]
  return {
    id: 7,
    subject: 'Cannot see my enrolment',
    status: TicketStatus.OPEN,
    category: null,
    requesterEmail: 'ada@example.com',
    requesterName: 'Ada Lovelace',
    lastMessageAt: '2026-09-28T11:30:00.000Z',
    createdAt: '2026-09-28T09:00:00.000Z',
    updatedAt: '2026-09-28T11:30:00.000Z',
    messageCount: messages.length,
    assignedTo: null,
    ...overrides,
    messages,
  }
}

function renderPage(url = '/tickets/7') {
  // `retry: false` so an error test is not waiting on the app client's retry.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const auth: AuthValue = { status: 'authenticated', user: agent, signIn: vi.fn(), signOut: vi.fn() }

  render(
    <QueryClientProvider client={queryClient}>
      <AuthContext value={auth}>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/tickets/:id" element={<TicketDetailPage />} />
          </Routes>
        </MemoryRouter>
      </AuthContext>
    </QueryClientProvider>,
  )

  return {
    heading: (name: string) => screen.findByRole('heading', { level: 1, name }),
    messages: () =>
      within(screen.getByRole('region', { name: 'Messages' })).getAllByRole('listitem'),
  }
}

/**
 * The value beside a label in the summary list. Scoped this way rather than by
 * its text, because a requester's name and address appear again on every
 * message they sent - and so does the opening message's timestamp.
 */
function field(label: string) {
  return screen.getByText(label).nextElementSibling
}

/** Paths `apiFetch` was called with, in order. */
function requestedPaths() {
  return mockedApiFetch.mock.calls.map(([path]) => path)
}

function dateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

describe('TicketDetailPage', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset()
  })

  it('shows a skeleton until the response, then the ticket and its thread', async () => {
    mockedApiFetch.mockResolvedValue({ ticket: detail() })
    const page = renderPage()

    // The placeholder is announced, but is not the heading a test waits for.
    expect(screen.getByRole('status')).toHaveTextContent('Loading ticket…')
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()

    await page.heading('Cannot see my enrolment')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    expect(screen.getByText('Open')).toBeInTheDocument()
    expect(field('Requester')).toHaveTextContent('Ada Lovelace (ada@example.com)')
    expect(field('Assigned to')).toHaveTextContent('Nobody')
    expect(field('Opened')).toHaveTextContent(dateTime('2026-09-28T09:00:00.000Z'))
    expect(field('Opened')?.querySelector('time')).toHaveAttribute(
      'datetime',
      '2026-09-28T09:00:00.000Z',
    )
    expect(field('Last message')).toHaveTextContent(dateTime(reply.createdAt))

    expect(
      screen.getByRole('heading', { level: 2, name: 'Messages (2)' }),
    ).toBeInTheDocument()

    const [first, second] = page.messages()
    expect(within(first!).getByText('Received')).toBeInTheDocument()
    expect(within(first!).getByText('I cannot see my enrolment.')).toBeInTheDocument()
    expect(within(second!).getByText('Sent')).toBeInTheDocument()
    expect(within(second!).getByText('Bob Agent')).toBeInTheDocument()
    expect(within(second!).getByText(dateTime(reply.createdAt))).toHaveAttribute(
      'datetime',
      reply.createdAt,
    )
  })

  it('requests the ticket in the URL and passes the query\'s abort signal', async () => {
    mockedApiFetch.mockResolvedValue({ ticket: detail({ id: 42 }) })
    const page = renderPage('/tickets/42')
    await page.heading('Cannot see my enrolment')

    expect(mockedApiFetch).toHaveBeenCalledTimes(1)
    expect(mockedApiFetch).toHaveBeenCalledWith(
      '/api/tickets/42',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  /**
   * The thread is rendered in the order it arrived - the server sends it
   * oldest first. Nothing here re-sorts, which is what this pins: the fixtures
   * are handed over newest first, so a page that trusted the array would pass
   * either way without the scrambling.
   */
  it('renders messages in the order the server returned them', async () => {
    mockedApiFetch.mockResolvedValue({ ticket: detail({ messages: [reply, message()] }) })
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    const bodies = page.messages().map((item) => item.textContent)
    expect(bodies[0]).toContain('Thanks for writing in.')
    expect(bodies[1]).toContain('I cannot see my enrolment.')
  })

  it('shows the category when a ticket has one, and an em dash when it has not', async () => {
    mockedApiFetch.mockResolvedValue({
      ticket: detail({ category: TicketCategory.REFUND_REQUEST }),
    })
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    expect(screen.getByText('Refund request')).toBeInTheDocument()
    expect(screen.queryByText('—')).not.toBeInTheDocument()
  })

  it('names the assigned agent when there is one', async () => {
    mockedApiFetch.mockResolvedValue({
      ticket: detail({
        assignedTo: { id: 'user-agent', name: 'Bob Agent', email: 'bob@example.com' },
      }),
    })
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    expect(field('Assigned to')).toHaveTextContent('Bob Agent')
    expect(screen.queryByText('Nobody')).not.toBeInTheDocument()
  })

  it('links back to the queue', async () => {
    mockedApiFetch.mockResolvedValue({ ticket: detail() })
    renderPage()

    expect(screen.getByRole('link', { name: '← All tickets' })).toHaveAttribute('href', '/tickets')
  })

  it('says so when the ticket does not exist', async () => {
    mockedApiFetch.mockRejectedValue(new ApiError(404, 'Ticket not found'))
    renderPage('/tickets/999')

    expect(await screen.findByRole('alert')).toHaveTextContent('Ticket not found')
    // Nothing arrived, so neither the content nor its placeholder remains.
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  /**
   * An id that is not a ticket number is a miss the page can see for itself,
   * so it never becomes a request that could only ever come back 404.
   */
  it('refuses an id that is not a ticket number without asking the server', async () => {
    renderPage('/tickets/abc')

    expect(await screen.findByRole('alert')).toHaveTextContent('Ticket not found')
    expect(requestedPaths()).toEqual([])
  })

  it('shows a generic message when the server cannot be reached', async () => {
    mockedApiFetch.mockRejectedValue(new Error('Network Error'))
    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reach the server. Please try again.',
    )
  })

  it('shows the server\'s message when it refuses the request', async () => {
    mockedApiFetch.mockRejectedValue(new ApiError(401, 'Authentication required'))
    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('Authentication required')
  })

  it('still renders a ticket with no messages', async () => {
    mockedApiFetch.mockResolvedValue({ ticket: detail({ messages: [] }) })
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    expect(screen.getByText('No messages on this ticket yet.')).toBeInTheDocument()
  })
})
