import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { ApiError, type PublicUser } from '../lib/api.ts'
import { ticketKeys } from '../lib/tickets.ts'
import { deleteUser, userKeys } from '../lib/users.ts'

const NETWORK_ERROR = 'Could not reach the server. Please try again.'

/**
 * The per-row delete button and the confirmation it opens. An `AlertDialog`
 * rather than a `Dialog` because the action is destructive: it announces as
 * `alertdialog`, focuses the confirm button, and an accidental click on the
 * overlay does not dismiss it - only Cancel or Escape.
 *
 * Deleting is soft (`DELETE /api/users/:id` sets `deletedAt` and `active:
 * false`), which is why the description promises only what happens - including
 * that the server hands their open tickets back to the unassigned queue, since
 * an admin choosing this has to know the queue moves underneath them. The
 * server refuses to delete an admin; `UsersTable` does not render this button
 * on an admin row, so that refusal is a boundary rather than something an
 * admin is expected to run into.
 */
export function DeleteUserDialog({ user }: { user: PublicUser }) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: () => deleteUser(user.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: userKeys.all })
      // The server unassigns the open tickets this user held, so any cached
      // ticket is stale - `all` rather than `lists()` because it is the detail
      // view that names an assignee, and nothing here has a fresh copy of it
      // to protect.
      void queryClient.invalidateQueries({ queryKey: ticketKeys.all })
    },
  })

  const error = mutation.error
    ? mutation.error instanceof ApiError
      ? mutation.error.message
      : NETWORK_ERROR
    : undefined

  // Escape and Cancel both arrive here, so this is the one place to refuse a
  // dismissal while the request is in flight. Opening clears the last result,
  // so a refusal from a previous attempt is not still on screen.
  const handleOpenChange = (next: boolean) => {
    if (!next && mutation.isPending) return
    if (next) mutation.reset()
    setOpen(next)
  }

  const confirm = async () => {
    try {
      await mutation.mutateAsync()
      setOpen(false)
    } catch {
      // Held in `mutation.error` and rendered below; the dialog stays open.
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Delete ${user.name}`}>
          <Trash2Icon aria-hidden="true" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {user.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            They will be signed out everywhere and cannot sign in again. Their open tickets go
            back to the unassigned queue; resolved and closed ones keep their name. The account is
            kept, so you can restore it later.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Reserves its line, so the dialog does not jump when the server
            refuses and the message appears. */}
        <p role="alert" className="min-h-2 text-sm text-destructive">
          {error}
        </p>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={mutation.isPending}
            // Radix closes on a click here, which would take a refusal off
            // screen with it. The mutation's outcome decides instead.
            onClick={(event) => {
              event.preventDefault()
              void confirm()
            }}
          >
            {mutation.isPending ? 'Deleting…' : 'Delete user'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
