import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiFetch, Role, type PublicUser } from '../lib/api.ts'
import { DeleteUserDialog } from './DeleteUserDialog.tsx'

// Only the HTTP boundary is replaced; the users API client and TanStack Query
// run for real, so the exact request the dialog builds can be asserted.
vi.mock('../lib/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.ts')>()
  return { ...actual, apiFetch: vi.fn() }
})
const mockedApiFetch = vi.mocked(apiFetch)

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

/** What the server answers with: the row, soft-deleted. */
const deleted: PublicUser = { ...agent, active: false, deletedAt: '2026-09-27T10:00:00.000Z' }

const NETWORK_ERROR = 'Could not reach the server. Please try again.'

function renderDialog(user: PublicUser = agent) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <DeleteUserDialog user={user} />
    </QueryClientProvider>,
  )
  return { queryClient }
}

type User = ReturnType<typeof userEvent.setup>

async function open(user: User) {
  await user.click(screen.getByRole('button', { name: `Delete ${agent.name}` }))
  return screen.findByRole('alertdialog', { name: 'Delete Bob Agent?' })
}

function confirm(user: User) {
  return user.click(screen.getByRole('button', { name: 'Delete user' }))
}

/** The dialog unmounts a tick after it closes, so its absence is awaited. */
function expectClosed() {
  return waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
}

describe('DeleteUserDialog', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset()
  })

  it('names its trigger after the user, so every row has a distinct button', () => {
    renderDialog()

    expect(screen.getByRole('button', { name: 'Delete Bob Agent' })).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('asks before deleting, and sends nothing until it is confirmed', async () => {
    const user = userEvent.setup()
    renderDialog()

    const dialog = await open(user)

    // The wording has to admit that the row survives: the delete is soft, so
    // tickets the person handled still name them. And that the queue moves:
    // the server hands their open tickets back.
    expect(within(dialog).getByText(/The account is\s+kept/)).toBeInTheDocument()
    expect(within(dialog).getByText(/restore it later/)).toBeInTheDocument()
    expect(within(dialog).getByText(/open tickets go\s+back to the unassigned queue/)).toBeInTheDocument()
    expect(mockedApiFetch).not.toHaveBeenCalled()
  })

  it('deletes on confirmation, refreshes the list and closes', async () => {
    mockedApiFetch.mockResolvedValue({ user: deleted })
    const user = userEvent.setup()
    const { queryClient } = renderDialog()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    await open(user)

    await confirm(user)

    await expectClosed()
    expect(mockedApiFetch).toHaveBeenCalledTimes(1)
    expect(mockedApiFetch).toHaveBeenCalledWith('/api/users/user-agent', { method: 'DELETE' })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['users'] })
    // The delete unassigns their open tickets server-side, so every cached
    // ticket is stale too.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tickets'] })
  })

  it('sends nothing when Cancel is chosen', async () => {
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await expectClosed()
    expect(mockedApiFetch).not.toHaveBeenCalled()
  })

  it('sends nothing when it is dismissed with Escape', async () => {
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await user.keyboard('{Escape}')

    await expectClosed()
    expect(mockedApiFetch).not.toHaveBeenCalled()
  })

  it('stays open with the server\'s message when the delete is refused', async () => {
    mockedApiFetch.mockRejectedValue(
      new ApiError(400, 'An admin cannot be deleted. Change their role first.'),
    )
    const user = userEvent.setup()
    renderDialog()
    const dialog = await open(user)

    await confirm(user)

    // The action button closes the dialog by default; if that were not
    // prevented, the refusal would vanish with it.
    expect(
      await screen.findByText('An admin cannot be deleted. Change their role first.'),
    ).toBeInTheDocument()
    expect(dialog).toBeInTheDocument()
  })

  it('shows a generic message when the server cannot be reached', async () => {
    mockedApiFetch.mockRejectedValue(new Error('Network Error'))
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await confirm(user)

    expect(await screen.findByText(NETWORK_ERROR)).toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('drops a previous refusal when it is reopened', async () => {
    mockedApiFetch.mockRejectedValue(new ApiError(400, 'You cannot deactivate your own account'))
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await confirm(user)
    expect(await screen.findByText('You cannot deactivate your own account')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await expectClosed()

    await open(user)
    expect(
      screen.queryByText('You cannot deactivate your own account'),
    ).not.toBeInTheDocument()
  })

  it('cannot be dismissed or confirmed twice while the request is in flight', async () => {
    let resolve!: (value: { user: PublicUser }) => void
    mockedApiFetch.mockReturnValue(new Promise((r) => (resolve = r)))
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await confirm(user)

    const deleting = await screen.findByRole('button', { name: 'Deleting…' })
    expect(deleting).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()

    await user.keyboard('{Escape}')
    // A close unmounts on a later tick, so give one the chance to happen.
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(mockedApiFetch).toHaveBeenCalledTimes(1)

    resolve({ user: deleted })
    await expectClosed()
  })
})
