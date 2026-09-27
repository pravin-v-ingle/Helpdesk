import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiFetch, Role, type PublicUser } from '../lib/api.ts'
import { EditUserDialog } from './EditUserDialog.tsx'

// Only the HTTP boundary is replaced; the users API client, the shared schema
// and TanStack Query run for real, so the exact PATCH body can be asserted.
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

const NETWORK_ERROR = 'Could not reach the server. Please try again.'

function renderDialog(user: PublicUser = agent) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <EditUserDialog user={user} />
    </QueryClientProvider>,
  )
  return { queryClient }
}

/**
 * Stands in for a table row whose data changes under the dialog, which is what
 * happens when the list refetches after a save.
 */
function renderRowWithRefetch() {
  function Row() {
    const [user, setUser] = useState(agent)
    return (
      <>
        <button onClick={() => setUser({ ...user, name: 'Bobby Agent' })}>simulate refetch</button>
        <EditUserDialog user={user} />
      </>
    )
  }

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <Row />
    </QueryClientProvider>,
  )
}

type User = ReturnType<typeof userEvent.setup>

async function open(user: User, name = agent.name) {
  await user.click(screen.getByRole('button', { name: `Edit ${name}` }))
  return screen.findByRole('dialog', { name: 'Edit user' })
}

/** Replaces a field's contents, the way an admin correcting a value would. */
async function retype(user: User, label: string, value: string) {
  await user.clear(screen.getByLabelText(label))
  if (value !== '') await user.type(screen.getByLabelText(label), value)
}

function save(user: User) {
  return user.click(screen.getByRole('button', { name: 'Save changes' }))
}

/** The dialog unmounts a tick after it closes, so its absence is awaited. */
function expectClosed() {
  return waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
}

describe('EditUserDialog', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset()
  })

  it('names its trigger after the user, so every row has a distinct button', () => {
    renderDialog()

    expect(screen.getByRole('button', { name: 'Edit Bob Agent' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens populated with the row\'s values and a blank password', async () => {
    const user = userEvent.setup()
    renderDialog()

    const dialog = await open(user)

    expect(screen.getByLabelText('Name')).toHaveValue('Bob Agent')
    expect(screen.getByLabelText('Email')).toHaveValue('bob@example.com')
    // The API never returns a password, so there is nothing to prefill.
    expect(screen.getByLabelText('Password')).toHaveValue('')
    expect(
      within(dialog).getByText('Leave the password blank to keep the current one.'),
    ).toBeInTheDocument()
    expect(mockedApiFetch).not.toHaveBeenCalled()
  })

  it('saves name and email without a password when the field is left blank', async () => {
    mockedApiFetch.mockResolvedValue({ user: { ...agent, name: 'Bobby Agent' } })
    const user = userEvent.setup()
    const { queryClient } = renderDialog()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    await open(user)

    await retype(user, 'Name', 'Bobby Agent')
    await save(user)

    await expectClosed()
    // No `password` key at all: the server leaves the existing one in place.
    expect(mockedApiFetch).toHaveBeenCalledWith('/api/users/user-agent', {
      method: 'PATCH',
      body: { name: 'Bobby Agent', email: 'bob@example.com' },
    })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['users'] })
  })

  it('sends the password when one is typed', async () => {
    mockedApiFetch.mockResolvedValue({ user: agent })
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await user.type(screen.getByLabelText('Password'), 'brand new secret')
    await save(user)

    await expectClosed()
    expect(mockedApiFetch).toHaveBeenCalledWith('/api/users/user-agent', {
      method: 'PATCH',
      body: {
        name: 'Bob Agent',
        email: 'bob@example.com',
        password: 'brand new secret',
      },
    })
  })

  it('sends a changed email lowercased and trimmed', async () => {
    mockedApiFetch.mockResolvedValue({ user: agent })
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await retype(user, 'Email', '  Bobby@Example.COM  ')
    await save(user)

    await expectClosed()
    expect(mockedApiFetch).toHaveBeenCalledWith('/api/users/user-agent', {
      method: 'PATCH',
      body: { name: 'Bob Agent', email: 'bobby@example.com' },
    })
  })

  it('refuses a short name, a bad email and a short password before sending', async () => {
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await retype(user, 'Name', 'ab')
    await retype(user, 'Email', 'nope')
    await user.type(screen.getByLabelText('Password'), '1234567')
    await save(user)

    expect(await screen.findByText('Name must be at least 3 characters.')).toBeInTheDocument()
    expect(screen.getByText('Email must be a valid email address.')).toBeInTheDocument()
    expect(screen.getByText('Password must be at least 8 characters.')).toBeInTheDocument()
    expect(mockedApiFetch).not.toHaveBeenCalled()
  })

  it('refuses an emptied name and email', async () => {
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await retype(user, 'Name', '')
    await retype(user, 'Email', '')
    await save(user)

    expect(await screen.findByText('Name must be at least 3 characters.')).toBeInTheDocument()
    expect(screen.getByText('Email is required.')).toBeInTheDocument()
    expect(mockedApiFetch).not.toHaveBeenCalled()
  })

  it('shows a duplicate email under the Email field and stays open', async () => {
    mockedApiFetch.mockRejectedValue(new ApiError(409, 'A user with that email already exists'))
    const user = userEvent.setup()
    renderDialog()
    const dialog = await open(user)

    await retype(user, 'Email', 'taken@example.com')
    await save(user)

    expect(await screen.findByText('A user with that email already exists')).toBeInTheDocument()
    expect(dialog).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Email')).toHaveValue('taken@example.com')
  })

  it('shows a server guard as a form-level error', async () => {
    mockedApiFetch.mockRejectedValue(new ApiError(400, 'You cannot change your own role'))
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await retype(user, 'Name', 'Bobby Agent')
    await save(user)

    expect(await screen.findByText('You cannot change your own role')).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('shows a generic message when the server cannot be reached', async () => {
    mockedApiFetch.mockRejectedValue(new Error('Network Error'))
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await save(user)

    expect(await screen.findByText(NETWORK_ERROR)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('restores the row\'s values after Cancel, discarding edits', async () => {
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await retype(user, 'Name', 'Discard me')
    await user.type(screen.getByLabelText('Password'), 'never sent')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await expectClosed()

    // Reopening starts from the user again, not from the abandoned edit.
    await open(user)
    expect(screen.getByLabelText('Name')).toHaveValue('Bob Agent')
    expect(screen.getByLabelText('Email')).toHaveValue('bob@example.com')
    expect(screen.getByLabelText('Password')).toHaveValue('')
    expect(mockedApiFetch).not.toHaveBeenCalled()
  })

  it('closes on Escape without saving', async () => {
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await retype(user, 'Name', 'Discard me')
    await user.keyboard('{Escape}')

    await expectClosed()
    expect(mockedApiFetch).not.toHaveBeenCalled()
  })

  it('reopens on the row\'s current values after the list has refreshed', async () => {
    // `useForm` reads `defaultValues` once, at mount, and this component stays
    // mounted while its row re-renders with the saved data. A reopen has to
    // show the new values, not the ones the form closed with.
    mockedApiFetch.mockResolvedValue({ user: { ...agent, name: 'Bobby Agent' } })
    const user = userEvent.setup()
    renderRowWithRefetch()

    await open(user)
    await retype(user, 'Name', 'Bobby Agent')
    await save(user)
    await expectClosed()

    // The list refetches and hands the row its saved values.
    await user.click(screen.getByRole('button', { name: 'simulate refetch' }))

    await open(user, 'Bobby Agent')
    expect(screen.getByLabelText('Name')).toHaveValue('Bobby Agent')
  })

  it('cannot be dismissed while the request is in flight', async () => {
    let resolve!: (value: { user: PublicUser }) => void
    mockedApiFetch.mockReturnValue(new Promise((r) => (resolve = r)))
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await retype(user, 'Name', 'Bobby Agent')
    await save(user)

    const saving = await screen.findByRole('button', { name: 'Saving…' })
    expect(saving).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()

    await user.keyboard('{Escape}')
    // A close unmounts on a later tick, so give one the chance to happen.
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    resolve({ user: agent })
    await expectClosed()
  })
})
