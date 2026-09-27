import { createUserSchema, type UserFormValues } from '@helpdesk/core/schemas/users'
import { Button } from '@/components/ui/button'
import { createUser } from '../lib/users.ts'
import { UserFormDialog } from './UserFormDialog.tsx'

const EMPTY_VALUES: UserFormValues = { name: '', email: '', password: '' }

/**
 * "Add user" button and the modal it opens, on top of the shared
 * `UserFormDialog`. There is no role picker - every account created here is an
 * agent, which the dialog says out loud.
 *
 * The schema is shared with `POST /api/users` (`@helpdesk/core`), so a value
 * this form accepts is one the server accepts, and the messages match. Running
 * it here first only saves the round trip; the server is still the authority.
 */
export function CreateUserDialog() {
  return (
    <UserFormDialog
      trigger={<Button>Add user</Button>}
      title="Add user"
      description="The new account is created as an agent."
      submitLabel="Create user"
      pendingLabel="Creating…"
      idPrefix="new-user"
      schema={createUserSchema}
      defaultValues={EMPTY_VALUES}
      submit={createUser}
    />
  )
}
