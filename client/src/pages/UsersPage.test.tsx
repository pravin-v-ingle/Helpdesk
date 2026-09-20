import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthValue } from '../auth/auth-context.ts'
import { ApiError, apiFetch, type PublicUser } from '../lib/api.ts'
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
  role: 'ADMIN',
  active: true,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
}

const agent: PublicUser = {
  id: 'user-agent',
  name: 'Bob Agent',
  email: 'bob@example.com',
  role: 'AGENT',
  active: true,
  createdAt: '2026-09-10T10:00:00.000Z',
  updatedAt: '2026-09-10T10:00:00.000Z',
}

const former: PublicUser = {
  id: 'user-former',
  name: 'Cy Former',
  email: 'cy@example.com',
  role: 'AGENT',
  active: false,
  createdAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-09-15T10:00:00.000Z',
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
      '/api/users?page=1&pageSize=20',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('reads its filters from the URL and reflects them in the controls', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([former], { total: 3, page: 2, pageSize: 2 }))
    const page = renderPage('/users?q=cy&role=AGENT&active=false&page=2&pageSize=2')
    await page.table()

    expect(requestedPaths()).toEqual(['/api/users?q=cy&role=AGENT&active=false&page=2&pageSize=2'])
    expect(screen.getByLabelText('Search')).toHaveValue('cy')
    expect(screen.getByRole('combobox', { name: 'Role' })).toHaveTextContent('Agent')
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('Inactive')
  })

  it('normalises URL values the server would refuse', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([admin]))
    const page = renderPage('/users?q=%20%20&role=OWNER&active=maybe&page=abc&pageSize=999')
    await page.table()

    // Blank search dropped, unknown role and status dropped, page defaulted,
    // page size clamped to the server's maximum.
    expect(requestedPaths()).toEqual(['/api/users?page=1&pageSize=100'])
    expect(screen.getByLabelText('Search')).toHaveValue('')
    expect(screen.getByRole('combobox', { name: 'Role' })).toHaveTextContent('All roles')
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('All statuses')
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
    expect(requestedPaths()).toEqual([
      '/api/users?page=2&pageSize=2',
      '/api/users?q=ada&page=1&pageSize=2',
    ])
  })

  it('filters by role through the select and drops the page', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([agent]))
    const user = userEvent.setup()
    const page = renderPage('/users?page=3')
    await page.table()

    await choose(user, 'Role', 'Agent')

    await waitFor(() => expect(page.search()).toBe('?role=AGENT'))
    expect(requestedPaths()).toContain('/api/users?role=AGENT&page=1&pageSize=20')
  })

  it('filters by status through the select', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([former]))
    const user = userEvent.setup()
    const page = renderPage()
    await page.table()

    await choose(user, 'Status', 'Inactive')

    await waitFor(() => expect(page.search()).toBe('?active=false'))
    expect(requestedPaths()).toContain('/api/users?active=false&page=1&pageSize=20')
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
      '/api/users?page=99&pageSize=2',
      '/api/users?page=2&pageSize=2',
    ])
  })

  it('tells an empty list apart from an empty filter result', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([]))

    const unfiltered = renderPage()
    expect(within(await unfiltered.table()).getByText('No users yet.')).toBeInTheDocument()
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument()
  })

  it('says so when filters match nothing', async () => {
    mockedApiFetch.mockResolvedValue(listResponse([]))
    const page = renderPage('/users?q=nobody')

    expect(within(await page.table()).getByText('No users match your filters.')).toBeInTheDocument()
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
