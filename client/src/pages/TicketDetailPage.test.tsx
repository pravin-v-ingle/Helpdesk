import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import type { TicketReplyInput } from '@helpdesk/core/schemas/tickets'
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
  type TicketPatch,
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

/** What the polish endpoint answers with unless a test says otherwise. */
const POLISHED = 'Thank you for getting in touch. I have fixed your enrolment.'

/**
 * What the summary endpoint answers with unless a test says otherwise. One line,
 * because `getByText` normalises whitespace - a newline in the fixture would never
 * match the rendered text however correctly the page displayed it.
 */
const SUMMARY = 'Ada cannot see her enrolment. Nothing has been done yet.'

/**
 * Answers every endpoint the page uses, by path and method - the detail GET, the
 * assignee list, the assignment PATCH, which echoes the ticket back with the new
 * assignee the way the server does, and the two POSTs.
 *
 * The three POSTs are told apart by path rather than method: the reply, the
 * polish and the summary are all posts to a path under the ticket, and only the
 * reply answers with a ticket.
 *
 * `summaries` is a queue rather than one string, because the summary endpoint is
 * the one thing here that is asked the same question twice and must answer afresh
 * - the last entry repeats once the queue runs out.
 */
function mockApi({
  ticket = detail(),
  assignees = [bob, dana],
  patchFails,
  replyFails,
  polished = POLISHED,
  polishFails,
  summaries = [SUMMARY],
  summaryFails,
  assigneesFail,
}: {
  ticket?: TicketDetail
  assignees?: Assignee[]
  patchFails?: Error
  replyFails?: Error
  polished?: string
  polishFails?: Error
  summaries?: string[]
  summaryFails?: Error
  assigneesFail?: Error
} = {}) {
  let summaryCalls = 0

  mockedApiFetch.mockImplementation(async (path, options) => {
    if (path === '/api/assignees') {
      if (assigneesFail) throw assigneesFail
      return { assignees }
    }
    if (options?.method === 'PATCH') {
      if (patchFails) throw patchFails
      return { ticket: applyPatch(ticket, options.body as TicketPatch, assignees) }
    }
    if (typeof path === 'string' && path.endsWith('/polish')) {
      if (polishFails) throw polishFails
      // Text, not a ticket: nothing was stored, so there is nothing to echo.
      return { body: polished }
    }
    if (typeof path === 'string' && path.endsWith('/summary')) {
      if (summaryFails) throw summaryFails
      const summary = summaries[Math.min(summaryCalls, summaries.length - 1)]
      summaryCalls += 1
      return { summary }
    }
    if (options?.method === 'POST') {
      if (replyFails) throw replyFails
      return { ticket: withReply(ticket, (options.body as TicketReplyInput).body) }
    }
    return { ticket }
  })
}

/**
 * What the server does with a reply: appends an outbound message from the
 * signed-in agent, moves `lastMessageAt` to it, and returns the whole ticket.
 * The count comes back too, so the page has no reason to recompute it.
 */
function withReply(ticket: TicketDetail, body: string): TicketDetail {
  const added = message({
    id: 99,
    direction: MessageDirection.OUTBOUND,
    fromEmail: agent.email,
    fromName: agent.name,
    body,
    createdAt: '2026-09-28T14:00:00.000Z',
  })
  const messages = [...ticket.messages, added]

  return { ...ticket, messages, messageCount: messages.length, lastMessageAt: added.createdAt }
}

const composer = () => screen.getByRole('textbox', { name: 'Your reply' })
const addReply = () => screen.getByRole('button', { name: 'Add reply' })
const polishButton = () => screen.getByRole('button', { name: 'Polish' })
const summarise = () => screen.getByRole('button', { name: 'Summarise ticket' })
const regenerate = () => screen.queryByRole('button', { name: 'Regenerate summary' })
const undoPolish = () => screen.queryByRole('button', { name: 'Undo polish' })

/**
 * What the server does with a patch, so the fake answers the way the real
 * endpoint does: the keys present are applied, the rest of the ticket is
 * untouched, and the whole ticket comes back.
 */
function applyPatch(ticket: TicketDetail, patch: TicketPatch, assignees: Assignee[]): TicketDetail {
  const next = { ...ticket }
  if ('assignedToId' in patch) {
    const found = assignees.find((assignee) => assignee.id === patch.assignedToId)
    next.assignedTo = found ? { id: found.id, name: found.name, email: found.email } : null
  }
  if (patch.status !== undefined) next.status = patch.status
  if ('category' in patch) next.category = patch.category ?? null
  return next
}

/** One of the three controls, each a Radix select named by the term beside it. */
function control(label: 'Status' | 'Category' | 'Assigned to') {
  return screen.getByRole('combobox', { name: label })
}

const assigneeSelect = () => control('Assigned to')

/**
 * Picks an option in one of the selects. Opened from the keyboard: under jsdom
 * the first pointer click on a trigger is dropped whenever an earlier test in
 * the file used user-event, so a click-to-open passes alone and fails in the
 * suite. Copied from `UsersPage.test.tsx`'s `choose`.
 */
async function choose(
  user: ReturnType<typeof userEvent.setup>,
  label: 'Status' | 'Category' | 'Assigned to',
  option: string,
) {
  // The assignee control is disabled until its list of candidates arrives, and
  // all three are disabled while a write is in flight.
  await waitFor(() => expect(control(label)).toBeEnabled())
  control(label).focus()
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

    expect(control('Status')).toHaveTextContent('Open')
    expect(control('Category')).toHaveTextContent('Uncategorised')
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

  it('shows the ticket\'s own status and category in the controls', async () => {
    mockApi({
      ticket: detail({ status: TicketStatus.CLOSED, category: TicketCategory.REFUND_REQUEST }),
    })
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    expect(control('Status')).toHaveTextContent('Closed')
    expect(control('Category')).toHaveTextContent('Refund request')
  })

  it('changes the status', async () => {
    mockApi()
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await choose(user, 'Status', 'Resolved')

    expect(mockedApiFetch).toHaveBeenCalledWith('/api/tickets/7', {
      method: 'PATCH',
      body: { status: 'RESOLVED' },
    })
    await waitFor(() => expect(control('Status')).toHaveTextContent('Resolved'))
  })

  /**
   * Every transition is offered, including back out of CLOSED: a student's
   * reply reopens a closed ticket by itself, so an agent may do the same.
   */
  it('reopens a closed ticket', async () => {
    mockApi({ ticket: detail({ status: TicketStatus.CLOSED }) })
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await choose(user, 'Status', 'Open')

    expect(mockedApiFetch).toHaveBeenCalledWith('/api/tickets/7', {
      method: 'PATCH',
      body: { status: 'OPEN' },
    })
    await waitFor(() => expect(control('Status')).toHaveTextContent('Open'))
  })

  it('classifies an uncategorised ticket', async () => {
    mockApi()
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await choose(user, 'Category', 'Technical question')

    expect(mockedApiFetch).toHaveBeenCalledWith('/api/tickets/7', {
      method: 'PATCH',
      body: { category: 'TECHNICAL_QUESTION' },
    })
    await waitFor(() => expect(control('Category')).toHaveTextContent('Technical question'))
  })

  /** `null`, not the list filter's `none`: a JSON body has a real null to use. */
  it('clears a category back to uncategorised', async () => {
    mockApi({ ticket: detail({ category: TicketCategory.GENERAL_QUESTION }) })
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await choose(user, 'Category', 'Uncategorised')

    expect(mockedApiFetch).toHaveBeenCalledWith('/api/tickets/7', {
      method: 'PATCH',
      body: { category: null },
    })
    await waitFor(() => expect(control('Category')).toHaveTextContent('Uncategorised'))
  })

  it('keeps the current status when the server refuses the change', async () => {
    mockApi({
      ticket: detail({ status: TicketStatus.OPEN }),
      patchFails: new ApiError(400, 'status must be OPEN, RESOLVED, CLOSED'),
    })
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await choose(user, 'Status', 'Closed')

    expect(await screen.findByText('status must be OPEN, RESOLVED, CLOSED')).toBeInTheDocument()
    expect(control('Status')).toHaveTextContent('Open')
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

    await choose(user, 'Assigned to', 'Dana Admin')

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

    await choose(user, 'Assigned to', 'Unassigned')

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

    await choose(user, 'Assigned to', 'Dana Admin')

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

    await choose(user, 'Assigned to', 'Bob Agent')

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
    // The composer is how that ticket stops being empty, so it is there too.
    expect(composer()).toBeInTheDocument()
  })

  it('adds a reply and shows it at the foot of the thread', async () => {
    mockApi()
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await user.type(composer(), 'I have fixed your enrolment.')
    await user.click(addReply())

    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith('/api/tickets/7/messages', {
        method: 'POST',
        body: { body: 'I have fixed your enrolment.' },
      }),
    )

    // The response is the whole ticket, written into the cache - so the thread,
    // its count and the Last message row all move with no second request.
    const messages = await waitFor(() => {
      const list = page.messages()
      expect(list).toHaveLength(3)
      return list
    })
    const last = messages[2]!
    expect(within(last).getByText('I have fixed your enrolment.')).toBeInTheDocument()
    expect(within(last).getByText('Sent')).toBeInTheDocument()
    expect(within(last).getByText('Bob Agent')).toBeInTheDocument()

    expect(screen.getByRole('heading', { level: 2, name: 'Messages (3)' })).toBeInTheDocument()
    expect(field('Last message')).toHaveTextContent(dateTime('2026-09-28T14:00:00.000Z'))

    // Cleared, so the next reply starts from nothing rather than from a copy
    // of the last one.
    expect(composer()).toHaveValue('')
    expect(requestedPaths().filter((path) => path === '/api/tickets/7')).toHaveLength(1)
  })

  it('refuses an empty reply without asking the server', async () => {
    mockApi()
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await user.click(addReply())

    // The shared schema's own sentence, which is what the server would have
    // answered with had the request gone.
    expect(await screen.findByText('Reply is required.')).toBeInTheDocument()
    expect(requestedPaths()).not.toContain('/api/tickets/7/messages')
    expect(page.messages()).toHaveLength(2)
  })

  it('refuses a reply of nothing but whitespace', async () => {
    mockApi()
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await user.type(composer(), '   ')
    await user.click(addReply())

    expect(await screen.findByText('Reply is required.')).toBeInTheDocument()
    expect(requestedPaths()).not.toContain('/api/tickets/7/messages')
  })

  it('keeps what was typed when the server refuses the reply', async () => {
    mockApi({ replyFails: new ApiError(404, 'Ticket not found') })
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await user.type(composer(), 'A reply that will not land.')
    await user.click(addReply())

    expect(await screen.findByText('Ticket not found')).toBeInTheDocument()
    // Nobody loses what they wrote to a failed request, and nothing was added
    // to the thread.
    expect(composer()).toHaveValue('A reply that will not land.')
    expect(page.messages()).toHaveLength(2)
  })

  it('shows a generic message when the reply never reaches the server', async () => {
    mockApi({ replyFails: new Error('Network Error') })
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await user.type(composer(), 'Hello.')
    await user.click(addReply())

    expect(
      await screen.findByText('Could not reach the server. Please try again.'),
    ).toBeInTheDocument()
    expect(composer()).toHaveValue('Hello.')
  })

  /**
   * Nothing is emailed until the outbound sender exists, and the composer says
   * so - a button that claimed to send would be the one lie this page cannot
   * afford.
   */
  it('says that the reply is not emailed to the requester', async () => {
    mockApi()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    expect(
      screen.getByText('Saved on the ticket. Nothing is emailed to Ada Lovelace yet.'),
    ).toBeInTheDocument()
  })

  /**
   * Polish sends the draft to be rewritten and puts the answer in its place.
   * Nothing is stored by it, which is what the thread and the message count
   * standing still are here to pin: the only thing that changed is the textarea.
   */
  it('polishes the draft and puts the rewrite in the composer', async () => {
    mockApi()
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await user.type(composer(), 'fixed ur enrolment')
    await user.click(polishButton())

    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith('/api/tickets/7/polish', {
        method: 'POST',
        body: { body: 'fixed ur enrolment' },
      }),
    )

    await waitFor(() => expect(composer()).toHaveValue(POLISHED))

    // A rewrite is not a reply: nothing was added to the thread, the count is
    // where it was, and no second request went out to fetch the ticket again.
    expect(page.messages()).toHaveLength(2)
    expect(screen.getByRole('heading', { level: 2, name: 'Messages (2)' })).toBeInTheDocument()
    expect(requestedPaths().filter((path) => path === '/api/tickets/7')).toHaveLength(1)

    // And it says what it did, because the text in the box is no longer what
    // the agent wrote.
    expect(screen.getByText('Rewritten from your draft. Read it before adding.')).toBeInTheDocument()
  })

  /**
   * There is nothing to improve about an empty draft, and asking anyway would
   * be inviting the model to write the reply itself - so the button is disabled
   * rather than refusing with a message.
   */
  it('offers nothing to polish until something is typed', async () => {
    mockApi()
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    expect(polishButton()).toBeDisabled()

    await user.type(composer(), 'Something to improve.')
    expect(polishButton()).toBeEnabled()

    // Whitespace is the empty draft it really is, the same view the shared
    // schema takes of it.
    await user.clear(composer())
    await user.type(composer(), '   ')
    expect(polishButton()).toBeDisabled()

    expect(requestedPaths()).not.toContain('/api/tickets/7/polish')
  })

  it('puts the draft back when the polish is undone', async () => {
    mockApi()
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await user.type(composer(), 'my own words')
    await user.click(polishButton())
    await waitFor(() => expect(composer()).toHaveValue(POLISHED))

    await user.click(undoPolish()!)

    expect(composer()).toHaveValue('my own words')
    // Nothing left to undo, so nothing offers to.
    expect(undoPolish()).not.toBeInTheDocument()
    expect(
      screen.queryByText('Rewritten from your draft. Read it before adding.'),
    ).not.toBeInTheDocument()
  })

  /**
   * The rewrite is what gets submitted - not the draft behind it. Worth pinning
   * because the form holds both, and sending the wrong one would be invisible
   * until a student read it.
   */
  it('adds the polished reply rather than the draft it replaced', async () => {
    mockApi()
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await user.type(composer(), 'fixed ur enrolment')
    await user.click(polishButton())
    await waitFor(() => expect(composer()).toHaveValue(POLISHED))

    await user.click(addReply())

    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith('/api/tickets/7/messages', {
        method: 'POST',
        body: { body: POLISHED },
      }),
    )

    const messages = await waitFor(() => {
      const list = page.messages()
      expect(list).toHaveLength(3)
      return list
    })
    expect(within(messages[2]!).getByText(POLISHED)).toBeInTheDocument()

    // The composer is empty again, and there is no draft left to go back to.
    expect(composer()).toHaveValue('')
    expect(undoPolish()).not.toBeInTheDocument()
  })

  /**
   * A server with no API key answers 503 with a sentence written for the agent
   * reading it, and the draft they wrote is still there.
   */
  it('keeps the draft when the server refuses to polish it', async () => {
    mockApi({
      polishFails: new ApiError(503, 'Reply polishing is not configured on this server.'),
    })
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await user.type(composer(), 'A draft nobody will improve.')
    await user.click(polishButton())

    expect(
      await screen.findByText('Reply polishing is not configured on this server.'),
    ).toBeInTheDocument()
    expect(composer()).toHaveValue('A draft nobody will improve.')
    // Nothing was replaced, so nothing offers to put anything back.
    expect(undoPolish()).not.toBeInTheDocument()
    expect(page.messages()).toHaveLength(2)
  })

  it('shows a generic message when the polish never reaches the server', async () => {
    mockApi({ polishFails: new Error('Network Error') })
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await user.type(composer(), 'Hello.')
    await user.click(polishButton())

    expect(
      await screen.findByText('Could not reach the server. Please try again.'),
    ).toBeInTheDocument()
    expect(composer()).toHaveValue('Hello.')
  })

  /**
   * The summary is asked for, never arrived at: nothing is requested on load, so
   * a ticket nobody wants summarised costs nothing.
   */
  it('does not summarise until asked', async () => {
    mockApi()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    expect(summarise()).toBeEnabled()
    expect(requestedPaths()).not.toContain('/api/tickets/7/summary')
    expect(screen.queryByText(SUMMARY)).not.toBeInTheDocument()
  })

  it('summarises the ticket and shows the result', async () => {
    mockApi()
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await user.click(summarise())

    await waitFor(() =>
      // No body: the ticket in the path is the whole input.
      expect(mockedApiFetch).toHaveBeenCalledWith('/api/tickets/7/summary', { method: 'POST' }),
    )

    expect(await screen.findByText(SUMMARY)).toBeInTheDocument()
    // A summary is not a message, so the thread and its count stand still.
    expect(page.messages()).toHaveLength(2)
    expect(screen.getByRole('heading', { level: 2, name: 'Messages (2)' })).toBeInTheDocument()
  })

  /**
   * Nothing is stored and nothing is cached, so pressing again asks again - which
   * is the point: a summary kept from the last press would be a claim about a
   * thread that has since moved on.
   */
  it('regenerates a fresh summary on every press', async () => {
    const second = 'The refund was paid. Nothing is outstanding.'
    mockApi({ summaries: [SUMMARY, second] })
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await user.click(summarise())
    expect(await screen.findByText(SUMMARY)).toBeInTheDocument()

    // The button now says what a second press does.
    const again = await waitFor(() => {
      const button = regenerate()
      expect(button).toBeInTheDocument()
      return button!
    })

    await user.click(again)

    expect(await screen.findByText(second)).toBeInTheDocument()
    expect(screen.queryByText(SUMMARY)).not.toBeInTheDocument()
    expect(requestedPaths().filter((path) => path === '/api/tickets/7/summary')).toHaveLength(2)
  })

  /**
   * A model handed an empty conversation would invent one, so the button is
   * disabled rather than refusing after the fact - the same treatment Polish
   * gives an empty draft.
   */
  it('offers nothing to summarise on a ticket with no messages', async () => {
    mockApi({ ticket: detail({ messages: [] }) })
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    expect(summarise()).toBeDisabled()
    expect(
      screen.getByText('There is nothing on this ticket to summarise yet.'),
    ).toBeInTheDocument()
    expect(requestedPaths()).not.toContain('/api/tickets/7/summary')
  })

  it("shows the server's message when the summary is refused", async () => {
    mockApi({
      summaryFails: new ApiError(503, 'AI features are not configured on this server.'),
    })
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await user.click(summarise())

    expect(
      await screen.findByText('AI features are not configured on this server.'),
    ).toBeInTheDocument()
    // Nothing was produced, so the button still offers the first summary.
    expect(regenerate()).not.toBeInTheDocument()
  })

  it('shows a generic message when the summary never reaches the server', async () => {
    mockApi({ summaryFails: new Error('Network Error') })
    const user = userEvent.setup()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    await user.click(summarise())

    expect(
      await screen.findByText('Could not reach the server. Please try again.'),
    ).toBeInTheDocument()
  })

  /**
   * Said on screen, because a summary that looked saved would be trusted later,
   * when the thread has moved on and it is no longer true.
   */
  it('says that the summary is written by AI and not saved', async () => {
    mockApi()
    const page = renderPage()
    await page.heading('Cannot see my enrolment')

    expect(
      screen.getByText(
        'Written by AI from the conversation. Not saved - each press summarises the thread as it stands.',
      ),
    ).toBeInTheDocument()
  })
})
