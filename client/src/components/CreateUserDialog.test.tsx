import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiFetch, Role, type PublicUser } from '../lib/api.ts'
import { CreateUserDialog } from './CreateUserDialog.tsx'

// Only the HTTP boundary is replaced; the users API client and TanStack Query
// run for real, so the exact request the dialog builds can be asserted.
vi.mock('../lib/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.ts')>()
  return { ...actual, apiFetch: vi.fn() }
})
const mockedApiFetch = vi.mocked(apiFetch)

const created: PublicUser = {
  id: 'user-new',
  name: 'Dana New',
  email: 'dana@example.com',
  role: Role.AGENT,
  active: true,
  deletedAt: null,
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
}

const NETWORK_ERROR = 'Could not reach the server. Please try again.'

function renderDialog() {
  // No router or auth: the dialog reads neither. `retry: false` is only for
  // symmetry with the page tests; mutations never retry by default.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <CreateUserDialog />
    </QueryClientProvider>,
  )
  return { queryClient }
}

type User = ReturnType<typeof userEvent.setup>

async function open(user: User) {
  await user.click(screen.getByRole('button', { name: 'Add user' }))
  return screen.findByRole('dialog', { name: 'Add user' })
}

async function fill(user: User, values: { name?: string; email?: string; password?: string }) {
  if (values.name) await user.type(screen.getByLabelText('Name'), values.name)
  if (values.email) await user.type(screen.getByLabelText('Email'), values.email)
  if (values.password) await user.type(screen.getByLabelText('Password'), values.password)
}

function submit(user: User) {
  return user.click(screen.getByRole('button', { name: 'Create user' }))
}

/** The dialog unmounts a tick after it closes, so its absence is awaited. */
function expectClosed() {
  return waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
}

describe('CreateUserDialog', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset()
  })

  it('opens from "Add user" with an empty form and focus on Name', async () => {
    const user = userEvent.setup()
    renderDialog()

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    const dialog = await open(user)

    expect(within(dialog).getByText('The new account is created as an agent.')).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('')
    expect(screen.getByLabelText('Email')).toHaveValue('')
    expect(screen.getByLabelText('Password')).toHaveValue('')
    expect(screen.getByLabelText('Name')).toHaveFocus()
    expect(mockedApiFetch).not.toHaveBeenCalled()
  })

  it('refuses an empty submit without calling the server', async () => {
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await submit(user)

    expect(await screen.findByText('Name must be at least 3 characters.')).toBeInTheDocument()
    expect(screen.getByText('Email is required.')).toBeInTheDocument()
    expect(screen.getByText('Password must be at least 8 characters.')).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true')
    expect(mockedApiFetch).not.toHaveBeenCalled()
  })

  it('validates each field\'s shape before sending', async () => {
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await fill(user, { name: 'ab', email: 'nope', password: '1234567' })
    await submit(user)

    expect(await screen.findByText('Name must be at least 3 characters.')).toBeInTheDocument()
    expect(screen.getByText('Email must be a valid email address.')).toBeInTheDocument()
    expect(screen.getByText('Password must be at least 8 characters.')).toBeInTheDocument()
    expect(mockedApiFetch).not.toHaveBeenCalled()
  })

  it('accepts a 128-character password and refuses a longer one', async () => {
    mockedApiFetch.mockResolvedValue({ user: created })
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    // 129 characters: one past the maximum the shared schema and Better Auth
    // both set. Typed straight into the field, since `fill` is for short values.
    await fill(user, { name: 'Dana New', email: 'dana@example.com' })
    await user.type(screen.getByLabelText('Password'), 'a'.repeat(129))
    await submit(user)

    expect(await screen.findByText('Password must be at most 128 characters.')).toBeInTheDocument()
    expect(mockedApiFetch).not.toHaveBeenCalled()

    // One character shorter is the boundary, and it goes through.
    await user.clear(screen.getByLabelText('Password'))
    await user.type(screen.getByLabelText('Password'), 'a'.repeat(128))
    await submit(user)

    await expectClosed()
    expect(mockedApiFetch).toHaveBeenCalledWith('/api/users', {
      method: 'POST',
      body: { name: 'Dana New', email: 'dana@example.com', password: 'a'.repeat(128) },
    })
  })

  it('sends the password exactly as typed, including surrounding spaces', async () => {
    mockedApiFetch.mockResolvedValue({ user: created })
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    // Deliberate: the schema trims the name and email but never the password,
    // because sign-in compares the raw string against the hash. Trimming here
    // would create an account that cannot be signed into with the password the
    // admin was given.
    await fill(user, {
      name: 'Dana New',
      email: '  dana@example.com  ',
      password: '  correct horse  ',
    })
    await submit(user)

    await expectClosed()
    expect(mockedApiFetch).toHaveBeenCalledWith('/api/users', {
      method: 'POST',
      body: { name: 'Dana New', email: 'dana@example.com', password: '  correct horse  ' },
    })
  })

  it('clears a field error once the value is corrected', async () => {
    mockedApiFetch.mockResolvedValue({ user: created })
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await fill(user, { name: 'ab', email: 'dana@example.com', password: 'correct horse' })
    await submit(user)
    expect(await screen.findByText('Name must be at least 3 characters.')).toBeInTheDocument()

    await user.type(screen.getByLabelText('Name'), 'c')
    await submit(user)

    await expectClosed()
    expect(mockedApiFetch).toHaveBeenCalledWith('/api/users', {
      method: 'POST',
      body: { name: 'abc', email: 'dana@example.com', password: 'correct horse' },
    })
  })

  it('recovers from a duplicate email: a new address succeeds', async () => {
    mockedApiFetch
      .mockRejectedValueOnce(new ApiError(409, 'A user with that email already exists'))
      .mockResolvedValueOnce({ user: created })
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await fill(user, { name: 'Dana New', email: 'taken@example.com', password: 'correct horse' })
    await submit(user)
    expect(await screen.findByText('A user with that email already exists')).toBeInTheDocument()

    await user.clear(screen.getByLabelText('Email'))
    await user.type(screen.getByLabelText('Email'), 'dana@example.com')
    await submit(user)

    await expectClosed()
    expect(mockedApiFetch).toHaveBeenCalledTimes(2)
    expect(mockedApiFetch).toHaveBeenLastCalledWith('/api/users', {
      method: 'POST',
      body: { name: 'Dana New', email: 'dana@example.com', password: 'correct horse' },
    })
  })

  it('drops a stale form-level error on the next submit', async () => {
    mockedApiFetch
      .mockRejectedValueOnce(new ApiError(500, 'Internal server error'))
      .mockResolvedValueOnce({ user: created })
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await fill(user, { name: 'Dana New', email: 'dana@example.com', password: 'correct horse' })
    await submit(user)
    expect(await screen.findByText('Internal server error')).toBeInTheDocument()

    await submit(user)

    await expectClosed()
    expect(screen.queryByText('Internal server error')).not.toBeInTheDocument()
  })

  it('creates the user, invalidates the list and closes', async () => {
    mockedApiFetch.mockResolvedValue({ user: created })
    const user = userEvent.setup()
    const { queryClient } = renderDialog()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    await open(user)

    // Padding around the name is trimmed before it is sent.
    await fill(user, { name: '  Dana New  ', email: 'dana@example.com', password: 'correct horse' })
    await submit(user)

    await expectClosed()
    expect(mockedApiFetch).toHaveBeenCalledTimes(1)
    expect(mockedApiFetch).toHaveBeenCalledWith('/api/users', {
      method: 'POST',
      body: { name: 'Dana New', email: 'dana@example.com', password: 'correct horse' },
    })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['users'] })
  })

  it('shows a duplicate email under the Email field and stays open', async () => {
    mockedApiFetch.mockRejectedValue(new ApiError(409, 'A user with that email already exists'))
    const user = userEvent.setup()
    renderDialog()
    const dialog = await open(user)

    await fill(user, { name: 'Dana New', email: 'dana@example.com', password: 'correct horse' })
    await submit(user)

    expect(await screen.findByText('A user with that email already exists')).toBeInTheDocument()
    expect(dialog).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-invalid')
    // The typed values survive so the admin can correct the address.
    expect(screen.getByLabelText('Name')).toHaveValue('Dana New')
    expect(screen.getByLabelText('Email')).toHaveValue('dana@example.com')
    expect(screen.getByLabelText('Password')).toHaveValue('correct horse')
  })

  it('shows any other refusal as a form-level error', async () => {
    mockedApiFetch.mockRejectedValue(new ApiError(403, 'Insufficient permissions'))
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await fill(user, { name: 'Dana New', email: 'dana@example.com', password: 'correct horse' })
    await submit(user)

    expect(await screen.findByText('Insufficient permissions')).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('shows a generic message when the server cannot be reached', async () => {
    mockedApiFetch.mockRejectedValue(new Error('Network Error'))
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await fill(user, { name: 'Dana New', email: 'dana@example.com', password: 'correct horse' })
    await submit(user)

    expect(await screen.findByText(NETWORK_ERROR)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('discards values and errors on Cancel, so a reopen is clean', async () => {
    mockedApiFetch.mockRejectedValue(new ApiError(409, 'A user with that email already exists'))
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await fill(user, { name: 'Dana New', email: 'dana@example.com', password: 'correct horse' })
    await submit(user)
    expect(await screen.findByText('A user with that email already exists')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await expectClosed()

    await open(user)
    expect(screen.getByLabelText('Name')).toHaveValue('')
    expect(screen.getByLabelText('Email')).toHaveValue('')
    expect(screen.getByLabelText('Password')).toHaveValue('')
    expect(screen.queryByText('A user with that email already exists')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid')
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await user.keyboard('{Escape}')

    await expectClosed()
    expect(mockedApiFetch).not.toHaveBeenCalled()
  })

  it('submits on Enter from within a field', async () => {
    mockedApiFetch.mockResolvedValue({ user: created })
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await fill(user, { name: 'Dana New', email: 'dana@example.com' })
    // Implicit submission: the form has one submit button, so Enter in a text
    // field triggers it. The admin never has to reach for the mouse.
    await user.type(screen.getByLabelText('Password'), 'correct horse{Enter}')

    await expectClosed()
    expect(mockedApiFetch).toHaveBeenCalledWith('/api/users', {
      method: 'POST',
      body: { name: 'Dana New', email: 'dana@example.com', password: 'correct horse' },
    })
  })

  it('cannot be dismissed while the request is in flight', async () => {
    let resolve!: (value: { user: PublicUser }) => void
    mockedApiFetch.mockReturnValue(new Promise((r) => (resolve = r)))
    const user = userEvent.setup()
    renderDialog()
    await open(user)

    await fill(user, { name: 'Dana New', email: 'dana@example.com', password: 'correct horse' })
    await submit(user)

    const creating = await screen.findByRole('button', { name: 'Creating…' })
    expect(creating).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()

    await user.keyboard('{Escape}')
    // A close unmounts on a later tick, so give one the chance to happen.
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeInTheDocument()

    resolve({ user: created })
    await expectClosed()
  })
})
