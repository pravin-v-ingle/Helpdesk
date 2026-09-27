import type { UserFormValues } from '@helpdesk/core/schemas/users'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { useForm } from 'react-hook-form'
import type { ZodType } from 'zod'
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
import { userKeys } from '../lib/users.ts'

const NETWORK_ERROR = 'Could not reach the server. Please try again.'

/**
 * The Name / Email / Password form, in a modal, behind a trigger. Both the
 * create and the edit dialog are this component with a different schema,
 * different starting values and a different mutation - the markup, the
 * dismissal rules and the error handling are shared so the two cannot drift.
 *
 * `TValues` is the schema's *output*, which is what the submit handler
 * receives: create's password is a string, edit's is optional.
 */
export function UserFormDialog<TValues>({
  trigger,
  title,
  description,
  submitLabel,
  pendingLabel,
  idPrefix,
  schema,
  defaultValues,
  submit,
}: {
  trigger: ReactNode
  title: string
  description: string
  submitLabel: string
  pendingLabel: string
  /** Prefixes the field ids, so two dialogs' inputs cannot collide. */
  idPrefix: string
  schema: ZodType<TValues, UserFormValues>
  defaultValues: UserFormValues
  submit: (values: TValues) => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()

  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<UserFormValues, unknown, TValues>({
    resolver: zodResolver(schema),
    defaultValues,
  })

  const mutation = useMutation({
    mutationFn: submit,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: userKeys.all }),
  })

  // Closing discards the form's values and errors along with the mutation's
  // last result, so nothing is carried over.
  const close = () => {
    setOpen(false)
    reset(defaultValues)
    mutation.reset()
  }

  // Every dismissal in controlled mode - Escape, the overlay, the X, Cancel -
  // arrives here, so this is the one place to refuse it while a request is
  // in flight.
  const handleOpenChange = (next: boolean) => {
    if (!next && isSubmitting) return
    if (!next) {
      close()
      return
    }

    // Reset on the way *in*, not only on the way out: `useForm` reads
    // `defaultValues` once, at mount, but this component stays mounted while
    // its row is re-rendered with fresh data after a save. Without this, a
    // reopened dialog would show whatever the form held when it last closed
    // rather than the row's current values.
    reset(defaultValues)
    mutation.reset()
    setOpen(true)
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
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent showCloseButton={!isSubmitting}>
        {/* The form sits inside the content so submit and Escape both work
            within the focus trap. Ids are prefixed so they cannot clash with
            the toolbar's `users-*` ids on the page behind. */}
        <form noValidate onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field data-invalid={errors.name ? true : undefined}>
              <FieldLabel htmlFor={`${idPrefix}-name`}>Name</FieldLabel>
              <Input
                id={`${idPrefix}-name`}
                autoComplete="name"
                autoFocus
                aria-invalid={errors.name ? true : undefined}
                {...register('name')}
              />
              <FieldError errors={[errors.name]} />
            </Field>

            <Field data-invalid={errors.email ? true : undefined}>
              <FieldLabel htmlFor={`${idPrefix}-email`}>Email</FieldLabel>
              <Input
                id={`${idPrefix}-email`}
                type="email"
                autoComplete="off"
                aria-invalid={errors.email ? true : undefined}
                {...register('email')}
              />
              <FieldError errors={[errors.email]} />
            </Field>

            <Field data-invalid={errors.password ? true : undefined}>
              <FieldLabel htmlFor={`${idPrefix}-password`}>Password</FieldLabel>
              <Input
                id={`${idPrefix}-password`}
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
              {isSubmitting ? pendingLabel : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
