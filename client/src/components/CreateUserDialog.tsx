import { createUserSchema, type CreateUserInput } from '@helpdesk/core/schemas/users'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ApiError } from '../lib/api.ts'
import { createUser, userKeys } from '../lib/users.ts'

const NETWORK_ERROR = 'Could not reach the server. Please try again.'

// The schema is shared with `POST /api/users` (`@helpdesk/core`), so a value
// this form accepts is one the server accepts, and the messages match. Running
// it here first only saves the round trip; the server is still the authority.
const EMPTY_VALUES: CreateUserInput = { name: '', email: '', password: '' }

/**
 * "Add user" button and the modal it opens. Self-contained: it owns the form
 * and the mutation, and on success invalidates `userKeys.all` so whichever
 * list is on screen refetches. There is no role picker - every account
 * created here is an agent, which the dialog says out loud. Edit and
 * deactivate are task 2.13c.
 */
export function CreateUserDialog() {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()

  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateUserInput>({
    resolver: zodResolver(createUserSchema),
    defaultValues: EMPTY_VALUES,
  })

  const mutation = useMutation({
    mutationFn: createUser,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: userKeys.all }),
  })

  // Closing discards everything: the form's values and errors, and the
  // mutation's last result, so a reopen starts clean.
  const close = () => {
    setOpen(false)
    reset()
    mutation.reset()
  }

  // Every dismissal in controlled mode - Escape, the overlay, the X, Cancel -
  // arrives here, so this is the one place to refuse it while a request is
  // in flight.
  const handleOpenChange = (next: boolean) => {
    if (!next && isSubmitting) return
    if (next) setOpen(true)
    else close()
  }

  const onSubmit = handleSubmit(async (values) => {
    try {
      await mutation.mutateAsync(values)
      close()
    } catch (err) {
      if (err instanceof ApiError) {
        // The service's 409 message was written to sit under the email field.
        if (err.status === 409) setError('email', { message: err.message })
        else setError('root', { message: err.message })
      } else {
        setError('root', { message: NETWORK_ERROR })
      }
    }
  })

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>Add user</Button>
      </DialogTrigger>
      <DialogContent showCloseButton={!isSubmitting}>
        {/* The form sits inside the content so submit and Escape both work
            within the focus trap. Ids are prefixed so they cannot clash with
            the toolbar's `users-*` ids on the page behind. */}
        <form noValidate onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
            <DialogDescription>The new account is created as an agent.</DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field data-invalid={errors.name ? true : undefined}>
              <FieldLabel htmlFor="new-user-name">Name</FieldLabel>
              <Input
                id="new-user-name"
                autoComplete="name"
                autoFocus
                aria-invalid={errors.name ? true : undefined}
                {...register('name')}
              />
              <FieldError errors={[errors.name]} />
            </Field>

            <Field data-invalid={errors.email ? true : undefined}>
              <FieldLabel htmlFor="new-user-email">Email</FieldLabel>
              <Input
                id="new-user-email"
                type="email"
                autoComplete="off"
                aria-invalid={errors.email ? true : undefined}
                {...register('email')}
              />
              <FieldError errors={[errors.email]} />
            </Field>

            <Field data-invalid={errors.password ? true : undefined}>
              <FieldLabel htmlFor="new-user-password">Password</FieldLabel>
              <Input
                id="new-user-password"
                type="password"
                autoComplete="new-password"
                aria-invalid={errors.password ? true : undefined}
                {...register('password')}
              />
              <FieldError errors={[errors.password]} />
            </Field>
          </FieldGroup>

          {/* Announced when the server refuses the request for a reason that
              belongs to no single field. Reserves its line so the dialog does
              not jump when a message appears. */}
          <p role="alert" className="min-h-2 text-sm text-destructive">
            {errors.root?.message}
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={isSubmitting} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create user'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
