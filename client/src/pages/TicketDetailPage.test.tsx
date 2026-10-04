import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthValue } from '../auth/auth-context.ts'
import { ApiError, apiFetch, Role, type PublicUser } from '../lib/api.ts'
import type { Assignee } from '../lib/assignees.ts'
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

/**
 * The people `/api/assignees` offers. An admin is in the list on purpose: the
 * server returns every active account, because an admin works tickets too.
 */
const bob: Assignee = {
  id: 'user-agent',
  name: 'Bob Agent',
  email: 'bob@example.com',
  role: Role.AGENT,
}

const dana: Assignee = {
  id: 'user-admin',
  name: 'Dana Admin',
  email: 'dana@example.com',
  role: Role.ADMIN,
}

/**
 * Answers both endpoints the page uses, by path and method - the detail GET,
 * the assignee list, and the assignment PATCH, which echoes the ticket back
 * with the new assignee the way the server does.
 */
function mockApi({
  ticket = detail(),
  assignees = [bob, dana],
  patchFails,
  assigneesFail,
}: {
  ticket?: TicketDetail
  assignees?: Assignee[]
  patchFails?: Error
  assigneesFail?: Error
} = {}) {
  mockedApiFetch.mockImplementation(async (path, options) => {
    if (path === '/api/assignees') {
      if (assigneesFail) throw assigneesFail
      return { assignees }
    }
    if (options?.method === 'PATCH') {
      if (patchFails) throw patchFails
      const { assignedToId } = options.body as { assignedToId: string | null }
      const next = assignees.find((assignee) => assignee.id === assignedToId) ?? null
      return {
        ticket: {
          ...ticket,
          assignedTo: next && { id: next.id, name: next.name, email: next.email },
        },
      }
    }
    return { ticket }
  })
}

/** The assignee control, which is a Radix select named by the term beside it. */
function assigneeSelect() {
  return screen.getByRole('combobox', { name: 'Assigned to' })
}

/**
 * Picks an option in the assignee select. Opened from the keyboard: under jsdom
 * the first pointer click on a trigger is dropped whenever an earlier test in
 * the file used user-event, so a click-to-open passes alone and fails in the
 * suite. Copied from `UsersPage.test.tsx`'s `choose`.
 */
async function choose(user: ReturnType<typeof userEvent.setup>, option: string) {
  // The control is disabled until the list of candidates has arrived.
  await waitFor(() => expect(assigneeSelect()).toBeEnabled())
  assigneeSelect().focus()
  await user.keyboard('{ArrowDown}')
  await user.click(await screen.findByRole('option', { name: option }))
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
    mockApi()
    const page = renderPage()

    // The placeholder is announced, but is not the heading a test waits for.
    expect(screen.getByRole('status')).toHaveTextContent('Loading ticket…')
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()

    await page.heading('Cannot see my enrolment')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    expect(screen.getByText('Open')).toBeInTheDocument()
    expect(field('Requester')).toHaveTextContent('Ada Lovelace (ada@example.com)')
    expect(assigneeSelect()).toHaveTextContent('Unassigned')
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
    mockApi({ ticket: detail({ id: 42 }) })
    const page = renderPage('/tickets/42')
    await page.heading('Cannot see my enrolment')

    expect(mockedApiFetch).toHaveBeenCalledWith(
      '/api/tickets/42',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    // The assignee list is the page's only other request, and it is a GET
    // with no parameters.
    await waitFor(() => expect(requestedPaths()).toEqual(['/api/tickets/42', '/api/assignees']))
  })

  /**
   * The thread is rendered in the order it arrived - the server sends it
   * oldest first. Nothing here re-sorts, which is what this pins: the fixtures
   * are handed over newest first, so a page that trusted the array would pass
   * either way without the scrambling.
   */
  it('renders messages in the order the server returned them', async () => {
    mockApi({ ticket: detail({ messages: [reply, message()] }) })
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    const bodies = page.messages().map((item) => item.textContent)
    expect(bodies[0]).toContain('Thanks for writing in.')
    expect(bodies[1]).toContain('I cannot see my enrolment.')
  })

  it('shows the category when a ticket has one, and an em dash when it has not', async () => {
    mockApi({ ticket: detail({ category: TicketCategory.REFUND_REQUEST }) })
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    expect(screen.getByText('Refund request')).toBeInTheDocument()
    expect(screen.queryByText('—')).not.toBeInTheDocument()
  })

  it('names who holds the ticket and offers everyone the server returns', async () => {
    mockApi({ ticket: detail({ assignedTo: bob }) })
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    expect(assigneeSelect()).toHaveTextContent('Bob Agent')

    await waitFor(() => expect(assigneeSelect()).toBeEnabled())
    assigneeSelect().focus()
    await user.keyboard('{ArrowDown}')

    // Unassigned first, then the people - the admin among them, because an
    // admin works tickets too.
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'Unassigned',
      'Bob Agent',
      'Dana Admin',
    ])
  })

  it('assigns the ticket to someone and shows the result', async () => {
    mockApi()
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await choose(user, 'Dana Admin')

    expect(mockedApiFetch).toHaveBeenCalledWith('/api/tickets/7', {
      method: 'PATCH',
      body: { assignedToId: 'user-admin' },
    })
    // The response is written straight into the detail cache, so the control
    // reads back from the server's answer rather than from a local guess.
    await waitFor(() => expect(assigneeSelect()).toHaveTextContent('Dana Admin'))
  })

  it('takes a ticket back off someone', async () => {
    mockApi({ ticket: detail({ assignedTo: bob }) })
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await choose(user, 'Unassigned')

    expect(mockedApiFetch).toHaveBeenCalledWith('/api/tickets/7', {
      method: 'PATCH',
      body: { assignedToId: null },
    })
    await waitFor(() => expect(assigneeSelect()).toHaveTextContent('Unassigned'))
  })

  /**
   * The control shows the ticket's assignee, not what was clicked, so a refusal
   * needs no undo: the value never moved off who actually holds it.
   */
  it('keeps the current assignee when the server refuses the change', async () => {
    mockApi({
      ticket: detail({ assignedTo: bob }),
      patchFails: new ApiError(400, 'A deactivated user cannot be assigned tickets.'),
    })
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await choose(user, 'Dana Admin')

    expect(
      await screen.findByText('A deactivated user cannot be assigned tickets.'),
    ).toBeInTheDocument()
    expect(assigneeSelect()).toHaveTextContent('Bob Agent')
  })

  it('shows a generic message when the assignment never reaches the server', async () => {
    mockApi({ patchFails: new Error('Network Error') })
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await choose(user, 'Bob Agent')

    expect(
      await screen.findByText('Could not reach the server. Please try again.'),
    ).toBeInTheDocument()
  })

  /**
   * An assignee who has since been deactivated has left the assignable list.
   * Without them being added back as an option the select would match nothing
   * and render blank - saying the ticket is unassigned when it is not.
   */
  it('still names an assignee the list no longer offers', async () => {
    const gone = { id: 'user-gone', name: 'Carol Former', email: 'carol@example.com' }
    mockApi({ ticket: detail({ assignedTo: gone }), assignees: [bob] })
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await waitFor(() => expect(assigneeSelect()).toHaveTextContent('Carol Former'))
  })

  it('says so when the list of people cannot be loaded', async () => {
    mockApi({ assigneesFail: new ApiError(500, 'Internal server error') })
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    expect(
      await screen.findByText('Could not load the list of people to assign to.'),
    ).toBeInTheDocument()
    // The ticket itself loaded, so the thread is still there to read.
    expect(page.messages()).toHaveLength(2)
  })

  it('links back to the queue', async () => {
    mockApi()
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
    mockApi({ ticket: detail({ messages: [] }) })
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    expect(screen.getByText('No messages on this ticket yet.')).toBeInTheDocument()
  })
})
