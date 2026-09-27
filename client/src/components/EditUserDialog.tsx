import { editUserSchema, type EditUserInput } from '@helpdesk/core/schemas/users'
import { PencilIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PublicUser } from '../lib/api.ts'
import { updateUser } from '../lib/users.ts'
import { UserFormDialog } from './UserFormDialog.tsx'

/**
 * The per-row edit button and the modal it opens, on top of the shared
 * `UserFormDialog`. The form starts from the row's own values; a blank
 * Password leaves the account's password as it is, which is why the field is
 * labelled as optional in the description rather than pre-filled with
 * anything.
 *
 * Role and active status are not edited here: the role has its own guards on
 * the server and no picker yet (task 2.13c covers the rest), and deactivation
 * is a separate action.
 */
export function EditUserDialog({ user }: { user: PublicUser }) {
  return (
    <UserFormDialog
      trigger={
        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${user.name}`}>
          <PencilIcon aria-hidden="true" />
        </Button>
      }
      title="Edit user"
      description="Leave the password blank to keep the current one."
      submitLabel="Save changes"
      pendingLabel="Saving…"
      idPrefix={`edit-user-${user.id}`}
      schema={editUserSchema}
      // The password is never sent back by the API, so it starts blank.
      defaultValues={{ name: user.name, email: user.email, password: '' }}
      submit={(values: EditUserInput) => updateUser(user.id, values)}
    />
  )
}
