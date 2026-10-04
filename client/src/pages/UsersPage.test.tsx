import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthValue } from '../auth/auth-context.ts'
import { ApiError, apiFetch, Role, type PublicUser } from '../lib/api.ts'
import type { UserListResponse } from '../lib/users.ts'
import { UsersPage } from './UsersPage.tsx'

// The page is tested down to the request it makes: `apiFetch` is replaced,
// everything above it - the users API client, TanStack Query, the router -
// is real. `ApiError` stays real so the page's error handling is exercised.
vi.mock('../lib/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.ts')>()
  return { ...actual, apiFetch: vi.fn() }
})
const mockedApiFetch = vi.mocked(apiFetch)

const admin: PublicUser = {
  id: 'user-admin',
  name: 'Ada Admin',
  email: 'ada@example.com',
  role: Role.ADMIN,
  active: true,
  deletedAt: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
}

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

const former: PublicUser = {
  id: 'user-former',
  name: 'Cy Former',
  email: 'cy@example.com',
  role: Role.AGENT,
  active: false,
  deletedAt: null,
  createdAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-09-15T10:00:00.000Z',
}

const newAgent: PublicUser = {
  id: 'user-new',
  name: 'Dana New',
  email: 'dana@example.com',
  role: Role.AGENT,
  active: true,
  deletedAt: null,
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
}

/** Soft-deleted: `deletedAt` set, and inactive with it - the two go together. */
const deleted: PublicUser = {
  id: 'user-deleted',
  name: 'Eve Deleted',
  email: 'eve@example.com',
  role: Role.AGENT,
  active: false,
  deletedAt: '2026-09-25T10:00:00.000Z',
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-09-25T10:00:00.000Z',
}

function listResponse(
  users: PublicUser[],
  overrides: Partial<Omit<UserListResponse, 'users'>> = {},
): UserListResponse {
  return { users, total: users.length, page: 1, pageSize: 20, ...overrides }
}

/** Exposes the router's query string so tests can assert on URL state. */
function LocationSpy() {
  const { search } = useLocation()
  return <span data-testid="location-search">{search}</span>
}

function renderPage(url = '/users', user: PublicUser = admin) {
  // `retry: false` so an error test is not waiting on the app client's retry.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const auth: AuthValue = { status: 'authenticated', user, signIn: vi.fn(), signOut: vi.fn() }

  render(
    <QueryClientProvider client={queryClient}>
      <AuthContext value={auth}>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route
              path="/users"
              element={
                <>
                  <UsersPage />
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
    table: () => screen.findByRole('table', { name: 'Users' }),
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

/** A column header, by its label - which is exactly the text it shows. */
function sortHeader(table: HTMLElement, label: string) {
  return within(table).getByRole('columnheader', { name: label })
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

/** Opens the create-user dialog from the page's own button. */
async function openCreateDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Add user' }))
  return screen.findByRole('dialog', { name: 'Add user' })
}

/**
 * Radix's dialog overlay - what a click "outside" actually lands on. It has no
 * role or accessible name of its own, so it is found by the `data-slot`
 * attribute shadcn puts on it; there is no better handle.
 */
function overlay() {
  const element = document.querySelector('[data-slot="dialog-overlay"]')
  if (!element) throw new Error('the dialog overlay is not on screen')
  return element
}

describe('UsersPage', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset()
  })

  it('shows a skeleton until the first response, then the table', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([agent, admin, former]))
    const page = renderPage()

    // The placeholder is announced, but is not the table a test would wait for.
    expect(screen.getByRole('status')).toHaveTextContent('Loading users…')
    expect(screen.queryByRole('table', { name: 'Users' })).not.toBeInTheDocument()

    const table = await page.table()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Name',
      'Email',
      'Role',
      'Status',
      'Created',
      'Actions',
    ])

    const rows = bodyRows(table)
    expect(rows).toHaveLength(3)

    const [agentRow, adminRow, formerRow] = rows
    expect(within(agentRow!).getByText('Bob Agent')).toBeInTheDocument()
    expect(within(agentRow!).getByText('bob@example.com')).toBeInTheDocument()
    expect(within(agentRow!).getByText('Agent')).toBeInTheDocument()
    expect(within(agentRow!).getByText('Active')).toBeInTheDocument()
    expect(within(agentRow!).getByText(shortDate(agent.createdAt))).toHaveAttribute(
      'datetime',
      agent.createdAt,
    )

    expect(within(adminRow!).getByText('Admin')).toBeInTheDocument()
    expect(within(formerRow!).getByText('Inactive')).toBeInTheDocument()
  })

  it('marks the signed-in user\'s own row', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([agent, admin]))
    const page = renderPage('/users', admin)

    const [agentRow, adminRow] = bodyRows(await page.table())
    expect(within(adminRow!).getByText('(you)')).toBeInTheDocument()
    expect(within(agentRow!).queryByText('(you)')).not.toBeInTheDocument()
  })

  it('requests page 1 of 20 by default and passes the query\'s abort signal', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([admin]))
    const page = renderPage()
    await page.table()

    expect(mockedApiFetch).toHaveBeenCalledTimes(1)
    expect(mockedApiFetch).toHaveBeenCalledWith(
      '/api/users?status=active&page=1&pageSize=20',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('reads its filters from the URL and reflects them in the controls', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([former], { total: 3, page: 2, pageSize: 2 }))
    const page = renderPage('/users?q=cy&role=AGENT&status=inactive&page=2&pageSize=2')
    await page.table()

    expect(requestedPaths()).toEqual([
      '/api/users?q=cy&role=AGENT&status=inactive&page=2&pageSize=2',
    ])
    expect(screen.getByLabelText('Search')).toHaveValue('cy')
    expect(screen.getByRole('combobox', { name: 'Role' })).toHaveTextContent('Agent')
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('Inactive')
  })

  it('normalises URL values the server would refuse', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([admin]))
    const page = renderPage(
      '/users?q=%20%20&role=OWNER&status=maybe&sortBy=bogus&sortDir=sideways&page=abc&pageSize=999',
    )
    await page.table()

    // Blank search dropped, unknown role and sort column dropped, page
    // defaulted, page size clamped to the server's maximum. `sortDir` goes
    // with the column it has no business without. An unusable status falls
    // back to the default rather than widening the list to everything.
    expect(requestedPaths()).toEqual(['/api/users?status=active&page=1&pageSize=100'])
    expect(screen.getByLabelText('Search')).toHaveValue('')
    expect(screen.getByRole('combobox', { name: 'Role' })).toHaveTextContent('All roles')
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('Active')
  })

  it('debounces typed search into the URL and returns to page 1', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([admin], { total: 3, page: 2, pageSize: 2 }))
    const user = userEvent.setup()
    const page = renderPage('/users?page=2&pageSize=2')
    await page.table()

    await user.type(screen.getByLabelText('Search'), 'ada')

    // Nothing leaves the input until the debounce elapses.
    expect(page.search()).toBe('?page=2&pageSize=2')
    expect(mockedApiFetch).toHaveBeenCalledTimes(1)

    await waitFor(() => expect(page.search()).toBe('?pageSize=2&q=ada'))
    // The refetch follows the URL change by a render, so it is awaited too -
    // asserting it synchronously here races the query and fails intermittently.
    await waitFor(() =>
      expect(requestedPaths()).toEqual([
        '/api/users?status=active&page=2&pageSize=2',
        '/api/users?q=ada&status=active&page=1&pageSize=2',
      ]),
    )
  })

  it('filters by role through the select and drops the page', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([agent]))
    const user = userEvent.setup()
    const page = renderPage('/users?page=3')
    await page.table()

    await choose(user, 'Role', 'Agent')

    await waitFor(() => expect(page.search()).toBe('?role=AGENT'))
    await waitFor(() =>
      expect(requestedPaths()).toContain('/api/users?role=AGENT&status=active&page=1&pageSize=20'),
    )
  })

  /**
   * Removal is soft, so every deactivated and deleted account stays in the
   * table for ever. The page therefore asks for the active ones unless the URL
   * says otherwise - and shows that in the control rather than applying a
   * filter the admin cannot see.
   */
  it('lists only the active accounts by default, and says so in the control', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([agent, admin]))
    const page = renderPage()
    await page.table()

    expect(requestedPaths()).toEqual(['/api/users?status=active&page=1&pageSize=20'])
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('Active')
    // The default is stored as absent, so the canonical URL stays bare.
    expect(page.search()).toBe('')
  })

  it('shows every account again through All statuses', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([agent, former, deleted]))
    const user = userEvent.setup()
    const page = renderPage()
    await page.table()

    await choose(user, 'Status', 'All statuses')

    await waitFor(() => expect(page.search()).toBe('?status=all'))
    // `all` is the page's own spelling for "no filter": it never reaches the
    // server, which would refuse it.
    await waitFor(() => expect(requestedPaths()).toContain('/api/users?page=1&pageSize=20'))
    expect(await screen.findByText('Eve Deleted')).toBeInTheDocument()
  })

  it('returns to the bare URL when Active is chosen explicitly', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([agent]))
    const user = userEvent.setup()
    const page = renderPage('/users?status=deleted')
    await page.table()

    await choose(user, 'Status', 'Active')

    await waitFor(() => expect(page.search()).toBe(''))
    await waitFor(() =>
      expect(requestedPaths()).toContain('/api/users?status=active&page=1&pageSize=20'),
    )
  })

  it('filters by status through the select', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([former]))
    const user = userEvent.setup()
    const page = renderPage()
    await page.table()

    await choose(user, 'Status', 'Inactive')

    await waitFor(() => expect(page.search()).toBe('?status=inactive'))
    await waitFor(() =>
      expect(requestedPaths()).toContain('/api/users?status=inactive&page=1&pageSize=20'),
    )
  })

  it('filters for deleted users through the select', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([deleted]))
    const user = userEvent.setup()
    const page = renderPage()
    await page.table()

    await choose(user, 'Status', 'Deleted')

    await waitFor(() => expect(page.search()).toBe('?status=deleted'))
    await waitFor(() =>
      expect(requestedPaths()).toContain('/api/users?status=deleted&page=1&pageSize=20'),
    )
    expect(await screen.findByText('Eve Deleted')).toBeInTheDocument()
  })

  /**
   * The list's default order is a composite - active accounts first, then
   * newest - that no single column describes, so claiming any one of them is
   * "the" sort would be a lie. This pins the decision not to change that
   * default when the headers became controls: no column sorted, and the
   * request unchanged from what it has always been.
   */
  it('shows no column as sorted by default', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([agent, admin]))
    const page = renderPage()
    const table = await page.table()

    for (const label of ['Name', 'Email', 'Role', 'Status', 'Created']) {
      expect(sortHeader(table, label)).toHaveAttribute('aria-sort', 'none')
    }
    expect(requestedPaths()).toEqual(['/api/users?status=active&page=1&pageSize=20'])
  })

  it('offers no sort on Actions', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([agent]))
    const page = renderPage()
    const table = await page.table()

    // Not `aria-sort="none"`, which would claim Actions is a sortable column
    // that happens to be unsorted.
    const actions = sortHeader(table, 'Actions')
    expect(actions).not.toHaveAttribute('aria-sort')
    expect(within(actions).queryByRole('button')).not.toBeInTheDocument()
  })

  it('sorts by a column header, reverses it, then clears back to the default', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([agent, admin]))
    const user = userEvent.setup()
    const page = renderPage()
    let table = await page.table()

    await user.click(within(table).getByRole('button', { name: 'Name' }))

    await waitFor(() => expect(page.search()).toBe('?sortBy=name&sortDir=asc'))
    // The refetch follows the URL change by a render, so it is awaited too -
    // asserting it synchronously here races the query and fails intermittently.
    await waitFor(() =>
      expect(requestedPaths()).toContain('/api/users?status=active&sortBy=name&sortDir=asc&page=1&pageSize=20'),
    )
    table = await page.table()
    expect(sortHeader(table, 'Name')).toHaveAttribute('aria-sort', 'ascending')

    await user.click(within(table).getByRole('button', { name: 'Name' }))

    await waitFor(() => expect(page.search()).toBe('?sortBy=name&sortDir=desc'))
    await waitFor(() =>
      expect(requestedPaths()).toContain('/api/users?status=active&sortBy=name&sortDir=desc&page=1&pageSize=20'),
    )
    table = await page.table()
    expect(sortHeader(table, 'Name')).toHaveAttribute('aria-sort', 'descending')

    // A third click removes the sort, which is the composite default - stored
    // as absent, so the URL goes bare and no column is sorted again.
    await user.click(within(table).getByRole('button', { name: 'Name' }))

    await waitFor(() => expect(page.search()).toBe(''))
    await waitFor(() => expect(requestedPaths().at(-1)).toBe('/api/users?status=active&page=1&pageSize=20'))
    expect(sortHeader(await page.table(), 'Name')).toHaveAttribute('aria-sort', 'none')
  })

  /**
   * Created is `sortDescFirst`, so one click asks for the newest rather than
   * the oldest - the useful half of a date column, and what the default order
   * already shows.
   */
  it('sorts Created descending on the first click', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([newAgent, agent]))
    const user = userEvent.setup()
    const page = renderPage()
    const table = await page.table()

    await user.click(within(table).getByRole('button', { name: 'Created' }))

    await waitFor(() => expect(page.search()).toBe('?sortBy=createdAt&sortDir=desc'))
    await waitFor(() =>
      expect(requestedPaths()).toContain(
        '/api/users?status=active&sortBy=createdAt&sortDir=desc&page=1&pageSize=20',
      ),
    )
  })

  it('reads the sort from the URL and reflects it in the headers', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([former, agent]))
    const page = renderPage('/users?sortBy=status&sortDir=desc')
    const table = await page.table()

    expect(requestedPaths()).toEqual(['/api/users?status=active&sortBy=status&sortDir=desc&page=1&pageSize=20'])
    expect(sortHeader(table, 'Status')).toHaveAttribute('aria-sort', 'descending')
    expect(sortHeader(table, 'Name')).toHaveAttribute('aria-sort', 'none')
  })

  it('drops the page when the sort changes', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([agent], { total: 9, page: 3, pageSize: 2 }))
    const user = userEvent.setup()
    const page = renderPage('/users?page=3&pageSize=2')
    const table = await page.table()

    await user.click(within(table).getByRole('button', { name: 'Email' }))

    // Re-ordering makes the page number meaningless, so it goes back to 1 -
    // which is stored as absent.
    await waitFor(() => expect(page.search()).toBe('?pageSize=2&sortBy=email&sortDir=asc'))
    await waitFor(() =>
      expect(requestedPaths()).toContain('/api/users?status=active&sortBy=email&sortDir=asc&page=1&pageSize=2'),
    )
  })

  it('pages with Previous and Next, disabled at the ends', async () => {
    mockedApiFetch.mockImplementation(async (path) => {
      const pageParam = new URL(path, 'http://test').searchParams.get('page')
      return pageParam === '2'
        ? listResponse([former], { total: 3, page: 2, pageSize: 2 })
        : listResponse([agent, admin], { total: 3, page: 1, pageSize: 2 })
    })
    const user = userEvent.setup()
    const page = renderPage('/users?pageSize=2')
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

  it('keeps the current rows on screen when a page change fails', async () => {
    mockedApiFetch.mockImplementation(async (path) => {
      if (path.includes('page=2')) throw new ApiError(500, 'Internal server error')
      return listResponse([agent, admin], { total: 3, page: 1, pageSize: 2 })
    })
    const user = userEvent.setup()
    const page = renderPage('/users?pageSize=2')
    await page.table()

    await user.click(screen.getByRole('button', { name: 'Next' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Internal server error')
    expect(bodyRows(await page.table())).toHaveLength(2)
    expect(screen.getByText('Showing 1–2 of 3')).toBeInTheDocument()
  })

  it('snaps a page past the end to the last page', async () => {
    mockedApiFetch.mockImplementation(async (path) => {
      const pageParam = new URL(path, 'http://test').searchParams.get('page')
      return pageParam === '99'
        ? listResponse([], { total: 3, page: 99, pageSize: 2 })
        : listResponse([former], { total: 3, page: 2, pageSize: 2 })
    })
    const page = renderPage('/users?page=99&pageSize=2')

    expect(await screen.findByText('Showing 3–3 of 3')).toBeInTheDocument()
    expect(page.search()).toBe('?page=2&pageSize=2')
    expect(requestedPaths()).toEqual([
      '/api/users?status=active&page=99&pageSize=2',
      '/api/users?status=active&page=2&pageSize=2',
    ])
  })

  it('tells an empty list apart from an empty filter result', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([]))

    // `all` is the only unfiltered view now that the page defaults to Active,
    // and so the only one where "no users yet" is a true statement.
    const unfiltered = renderPage('/users?status=all')
    expect(within(await unfiltered.table()).getByText('No users yet.')).toBeInTheDocument()
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument()
  })

  it('says so when filters match nothing', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([]))
    const page = renderPage('/users?q=nobody')

    expect(within(await page.table()).getByText('No users match your filters.')).toBeInTheDocument()
  })

  it('adds a user through the dialog and refreshes the list', async () => {
    // The list answers with the new row only once the POST has been made.
    let created = false
    mockedApiFetch.mockImplementation(async (_path, options) => {
      if (options?.method === 'POST') {
        created = true
        return { user: newAgent }
      }
      return listResponse(created ? [newAgent, admin] : [admin])
    })
    const user = userEvent.setup()
    const page = renderPage()
    expect(bodyRows(await page.table())).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Add user' }))
    await screen.findByRole('dialog', { name: 'Add user' })
    await user.type(screen.getByLabelText('Name'), newAgent.name)
    await user.type(screen.getByLabelText('Email'), newAgent.email)
    await user.type(screen.getByLabelText('Password'), 'correct horse')
    await user.click(screen.getByRole('button', { name: 'Create user' }))

    // Radix hides the page from assistive technology while the dialog is
    // open, so the table is only queryable again once it has gone.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByText(newAgent.name)).toBeInTheDocument()
    expect(bodyRows(await page.table())).toHaveLength(2)
    expect(requestedPaths()).toEqual([
      '/api/users?status=active&page=1&pageSize=20',
      '/api/users',
      '/api/users?status=active&page=1&pageSize=20',
    ])
  })

  it('edits a user from its row and refreshes the list', async () => {
    // The list answers with the new name only once the PATCH has been made.
    let renamed = false
    mockedApiFetch.mockImplementation(async (_path, options) => {
      if (options?.method === 'PATCH') {
        renamed = true
        return { user: { ...agent, name: 'Bobby Agent' } }
      }
      return listResponse([renamed ? { ...agent, name: 'Bobby Agent' } : agent])
    })
    const user = userEvent.setup()
    const page = renderPage()
    expect(within(await page.table()).getByText('Bob Agent')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Edit Bob Agent' }))
    await screen.findByRole('dialog', { name: 'Edit user' })
    // The dialog opens on the row's own values, so only the change is typed.
    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'Bobby Agent')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    // Radix hides the page from assistive technology while the dialog is
    // open, so the table is only queryable again once it has gone.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByText('Bobby Agent')).toBeInTheDocument()
    expect(requestedPaths()).toEqual([
      '/api/users?status=active&page=1&pageSize=20',
      '/api/users/user-agent',
      '/api/users?status=active&page=1&pageSize=20',
    ])
  })

  it('gives every row its own edit button', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([agent, admin, former]))
    const page = renderPage()
    await page.table()

    expect(screen.getByRole('button', { name: 'Edit Bob Agent' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit Ada Admin' })).toBeInTheDocument()
    // Deactivated users can still be edited.
    expect(screen.getByRole('button', { name: 'Edit Cy Former' })).toBeInTheDocument()
  })

  it('offers delete on agents but never on an admin', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([agent, admin, former]))
    const page = renderPage()
    await page.table()

    expect(screen.getByRole('button', { name: 'Delete Bob Agent' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete Cy Former' })).toBeInTheDocument()
    // The server refuses to delete an admin, so the page does not offer it -
    // while still letting one be edited, which is how a demotion happens.
    expect(screen.queryByRole('button', { name: 'Delete Ada Admin' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit Ada Admin' })).toBeInTheDocument()
  })

  it('shows a deleted user as Deleted rather than Inactive', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([former, deleted]))
    const page = renderPage()

    const [formerRow, deletedRow] = bodyRows(await page.table())
    expect(within(formerRow!).getByText('Inactive')).toBeInTheDocument()
    expect(within(deletedRow!).getByText('Deleted')).toBeInTheDocument()
    expect(within(deletedRow!).queryByText('Inactive')).not.toBeInTheDocument()
  })

  it('deletes a user from its row, leaving the row in the list as Deleted', async () => {
    // The list answers with the deleted row only once the DELETE has been made.
    let removed = false
    mockedApiFetch.mockImplementation(async (_path, options) => {
      if (options?.method === 'DELETE') {
        removed = true
        return { user: { ...agent, active: false, deletedAt: '2026-09-27T10:00:00.000Z' } }
      }
      return listResponse([
        removed ? { ...agent, active: false, deletedAt: '2026-09-27T10:00:00.000Z' } : agent,
      ])
    })
    const user = userEvent.setup()
    const page = renderPage()
    expect(within(await page.table()).getByText('Active')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Delete Bob Agent' }))
    await screen.findByRole('alertdialog', { name: 'Delete Bob Agent?' })
    await user.click(screen.getByRole('button', { name: 'Delete user' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    // Soft: the row is still there, now marked Deleted.
    const rows = bodyRows(await page.table())
    expect(rows).toHaveLength(1)
    expect(within(rows[0]!).getByText('Bob Agent')).toBeInTheDocument()
    expect(await screen.findByText('Deleted')).toBeInTheDocument()
    expect(requestedPaths()).toEqual([
      '/api/users?status=active&page=1&pageSize=20',
      '/api/users/user-agent',
      '/api/users?status=active&page=1&pageSize=20',
    ])
  })

  it('opens the create dialog from the "Add user" button', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([admin]))
    const user = userEvent.setup()
    const page = renderPage()
    await page.table()

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add user' }))

    const dialog = await screen.findByRole('dialog', { name: 'Add user' })
    expect(within(dialog).getByLabelText('Name')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Email')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Password')).toBeInTheDocument()
    // Opening the dialog asks the server for nothing.
    expect(requestedPaths()).toEqual(['/api/users?status=active&page=1&pageSize=20'])
  })

  it('closes the create dialog on Escape, leaving the list untouched', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([admin]))
    const user = userEvent.setup()
    const page = renderPage()
    await page.table()
    await openCreateDialog(user)

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // The page behind is reachable again, and nothing was created.
    expect(bodyRows(await page.table())).toHaveLength(1)
    expect(requestedPaths()).toEqual(['/api/users?status=active&page=1&pageSize=20'])
  })

  it('closes the create dialog on a click outside it', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([admin]))
    const user = userEvent.setup()
    const page = renderPage()
    await page.table()
    await openCreateDialog(user)

    await user.click(overlay())

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(bodyRows(await page.table())).toHaveLength(1)
    expect(requestedPaths()).toEqual(['/api/users?status=active&page=1&pageSize=20'])
  })

  it('discards what was typed when the dialog is dismissed and reopened', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([admin]))
    const user = userEvent.setup()
    const page = renderPage()
    await page.table()
    await openCreateDialog(user)

    await user.type(screen.getByLabelText('Name'), 'Dana New')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await openCreateDialog(user)
    expect(screen.getByLabelText('Name')).toHaveValue('')
  })

  it('shows the server\'s message when it refuses the request', async () => {
    mockedApiFetch.mockRejectedValue(new ApiError(403, 'Insufficient permissions'))
    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('Insufficient permissions')
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
