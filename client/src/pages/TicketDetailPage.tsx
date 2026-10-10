import { ticketReplySchema, type TicketReplyInput } from '@helpdesk/core/schemas/tickets'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { SparklesIcon } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, useParams } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { TICKET_CATEGORY_LABELS, TICKET_STATUS_LABELS } from '../components/TicketsTable.tsx'
import { ApiError } from '../lib/api.ts'
import { assigneeListQueryOptions, type Assignee } from '../lib/assignees.ts'
import {
  isTicketCategory,
  isTicketStatus,
  MessageDirection,
  polishReply,
  replyToTicket,
  summarizeTicket,
  ticketDetailQueryOptions,
  ticketKeys,
  updateTicket,
  type TicketDetail,
  type TicketMessage,
  type TicketPatch,
} from '../lib/tickets.ts'

const NETWORK_ERROR = 'Could not reach the server. Please try again.'

/** The same message the server sends for a 404, shown for an unusable id too. */
const NOT_FOUND = 'Ticket not found'

/**
 * The two selects' "no value" options. Radix refuses an empty value, so each
 * needs a sentinel; `none` is the one the queue's category filter already uses
 * on the wire, and the body sends `null` for both.
 */
const UNASSIGNED = 'unassigned'
const NO_CATEGORY = 'none'

/**
 * Which way a message travelled, from the agent's point of view. "Received"
 * rather than "Inbound": the labels describe what happened to the person
 * reading them, not the direction column they come from.
 */
const DIRECTION_LABELS: Record<MessageDirection, string> = {
  INBOUND: 'Received',
  OUTBOUND: 'Sent',
}

const DIRECTION_VARIANTS: Record<MessageDirection, 'secondary' | 'outline'> = {
  INBOUND: 'secondary',
  OUTBOUND: 'outline',
}

/**
 * The id from `/tickets/:id`, or `undefined` when the URL carries something
 * that is not a ticket number. Checked here rather than left to the server, so
 * `/tickets/abc` shows "Ticket not found" without a request that could only
 * ever 404.
 */
function readTicketId(param: string | undefined): number | undefined {
  if (param === undefined || !/^\d+$/.test(param)) return undefined
  const id = Number(param)
  return Number.isSafeInteger(id) && id >= 1 ? id : undefined
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * One ticket and its thread. Reached from the subject link on `/tickets`, and
 * `requireAuth` only on the server for the same reason that page is: working
 * tickets is the agent's job, so this sits outside the `RequireRole` branch of
 * the route table.
 *
 * Two columns from `lg` up: the thread and the reply composer on the left, the
 * ticket's own fields on the right, where the three selects that write to it
 * live. Below `lg` they stack, thread first.
 */
export function TicketDetailPage() {
  const { id: idParam } = useParams()
  const id = readTicketId(idParam)

  const query = useQuery({
    ...ticketDetailQueryOptions(id ?? 0),
    // An unusable id never becomes a request; the "not found" below is shown
    // from the URL alone.
    enabled: id !== undefined,
  })

  const error =
    id === undefined
      ? NOT_FOUND
      : query.error
        ? query.error instanceof ApiError
          ? query.error.message
          : NETWORK_ERROR
        : undefined

  return (
    <main className="flex-1 px-6 py-8">
      {/* Back to the queue, not `history.back()`: an agent may have arrived
          here from a link or a reload, where there is nothing to go back to. */}
      <Link
        to="/tickets"
        className="link mb-6 inline-block text-sm text-muted-foreground"
      >
        ← All tickets
      </Link>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {query.data ? (
        <TicketView ticket={query.data} />
      ) : (
        // A skeleton promises content is coming, so it gives way to the alert
        // alone once there is nothing left to wait for.
        !error && <TicketSkeleton />
      )}
    </main>
  )
}

function TicketView({ ticket }: { ticket: TicketDetail }) {
  // One mutation behind all three controls, so a write in flight disables the
  // others and every refusal reports in the same place, below the list.
  const update = useTicketUpdate(ticket.id)

  const error = update.error
    ? update.error instanceof ApiError
      ? update.error.message
      : NETWORK_ERROR
    : undefined

  return (
    <>
      {/* Above the heading, not beside the status in the Details card, and that
          placement is the whole argument for it: it is not another property of
          the ticket, it changes how everything below should be read. An agent
          who scrolls to the reply first has still seen it. */}
      <AutoResolvedNotice at={ticket.autoResolvedAt} />

      {/* The subject spans both columns: it names the whole page, not the
          thread, and wrapping it inside one column would make the other look
          like a second page beside it. */}
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">{ticket.subject}</h1>

      {/* Two columns from `lg` up - the thread, then the ticket's own fields -
          and one stacked column below it, where a 22rem sidebar beside the
          messages would leave neither enough room. `minmax(0,1fr)` rather than
          `1fr` so a long unbroken line in a message cannot push the grid wider
          than the viewport. `items-start` keeps the sidebar its own height,
          which is what lets it stick. */}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        {/* The thread and the composer share the left column, in that order:
            an agent reads before writing, and the reply belongs at the foot of
            the conversation it answers rather than above it. */}
        <div className="flex flex-col gap-8">
          <section aria-label="Messages">
            <h2 className="mb-4 text-lg font-semibold tracking-tight">
              Messages ({ticket.messageCount})
            </h2>

            {ticket.messages.length === 0 ? (
              // Not reachable through the inbound path, which creates a ticket
              // and its first message together - but a page that renders
              // nothing at all would be indistinguishable from one that failed.
              <p className="text-sm text-muted-foreground">No messages on this ticket yet.</p>
            ) : (
              <ol className="flex flex-col gap-4">
                {ticket.messages.map((message) => (
                  <li key={message.id}>
                    <MessageCard message={message} />
                  </li>
                ))}
              </ol>
            )}
          </section>

          <TicketSummary ticket={ticket} />

          <ReplyComposer ticket={ticket} />
        </div>

        {/* The ticket's own fields, second in the DOM as well as on the right:
            the thread is what an agent came to read, and stacking below `lg`
            should put it first. Sticky, so the controls stay reachable however
            long the thread gets - `top-6` matches the page's own padding. */}
        <aside aria-label="Ticket details" className="lg:sticky lg:top-6">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              {/* A description list rather than prose: each fact has a label an
                  assistive technology reads with its value - and the three that
                  are editable are rows like the three that are not, rather than
                  a separate toolbar saying the same things twice. Label above
                  value, because a 22rem column has no room for two. */}
              <dl className="flex flex-col gap-4 text-sm">
                <div className="flex flex-col gap-1.5">
                  <dt className="text-muted-foreground">Status</dt>
                  <dd>
                    <StatusSelect ticket={ticket} update={update} />
                  </dd>
                </div>

                <div className="flex flex-col gap-1.5">
                  <dt className="text-muted-foreground">Category</dt>
                  {/* Null until the Phase 5 classifier runs, so Uncategorised
                      is where every ticket starts and clearing one back to it
                      is allowed. */}
                  <dd>
                    <CategorySelect ticket={ticket} update={update} />
                  </dd>
                </div>

                <div className="flex flex-col gap-1.5">
                  <dt className="text-muted-foreground">Assigned to</dt>
                  {/* Every ticket arrives unassigned - inbound mail names no
                      one to give it to - so Unassigned is the normal state,
                      not an edge. */}
                  <dd>
                    <AssigneeSelect ticket={ticket} update={update} />
                  </dd>
                </div>

                <div className="flex flex-col gap-1.5">
                  <dt className="text-muted-foreground">Requester</dt>
                  <dd>
                    {ticket.requesterName}{' '}
                    <span className="break-words text-muted-foreground">
                      ({ticket.requesterEmail})
                    </span>
                  </dd>
                </div>

                <div className="flex flex-col gap-1.5">
                  <dt className="text-muted-foreground">Opened</dt>
                  <dd>
                    <time dateTime={ticket.createdAt}>{formatDateTime(ticket.createdAt)}</time>
                  </dd>
                </div>

                <div className="flex flex-col gap-1.5">
                  <dt className="text-muted-foreground">Last message</dt>
                  <dd>
                    <time dateTime={ticket.lastMessageAt}>
                      {formatDateTime(ticket.lastMessageAt)}
                    </time>
                  </dd>
                </div>
              </dl>

              {error && (
                <p role="alert" className="mt-4 text-sm text-destructive">
                  {error}
                </p>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  )
}

/**
 * The one write this page makes. Every control goes through it, so they cannot
 * disagree about what is in flight or where a refusal is reported.
 *
 * The response is the whole ticket, written straight into the detail query's
 * cache: no refetch, and no second shape to keep in step. The queue's cached
 * pages are a different matter - they show status and category, and a change
 * here can move a ticket out of the filter a page was built from - so those are
 * invalidated rather than patched. `ticketKeys.lists()` and not `all`, which
 * would throw away the fresh detail this just stored.
 */
function useTicketUpdate(id: number) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (patch: TicketPatch) => updateTicket(id, patch),
    onSuccess: (updated) => storeTicket(queryClient, updated),
  })
}

/**
 * What every write on this page does with the ticket it gets back, in one
 * place so the three selects and the composer cannot disagree about it.
 *
 * The detail is stored rather than refetched - the response *is* the new truth,
 * and a refetch would be a second request for something already in hand. The
 * queue's cached pages are invalidated instead of patched: a reply moves
 * `lastMessageAt` and the message count, which are two of the columns it sorts
 * and shows, so the page it belongs on may no longer be the page it is cached
 * under.
 */
function storeTicket(queryClient: QueryClient, ticket: TicketDetail) {
  queryClient.setQueryData(ticketKeys.detail(ticket.id), ticket)
  void queryClient.invalidateQueries({ queryKey: ticketKeys.lists() })
}

type TicketUpdate = ReturnType<typeof useTicketUpdate>

/**
 * Where the ticket is in its lifecycle. Every transition is offered, CLOSED
 * back to OPEN included: a student's reply reopens a closed ticket by itself
 * (see the inbound rules), so an agent may do by hand what the mail does on its
 * own.
 */
function StatusSelect({ ticket, update }: { ticket: TicketDetail; update: TicketUpdate }) {
  return (
    <Select
      // The ticket's own value, not what was last clicked, so a refusal needs
      // no undo - the control never left the truth.
      value={ticket.status}
      onValueChange={(value) => {
        if (isTicketStatus(value)) update.mutate({ status: value })
      }}
      disabled={update.isPending}
    >
      <SelectTrigger id="ticket-status" aria-label="Status" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(TICKET_STATUS_LABELS).map(([value, label]) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * What the ticket is about. `Uncategorised` is a real option rather than a
 * placeholder: it is where every ticket starts until the Phase 5 classifier
 * runs, and an agent who miscategorised one has to be able to put it back.
 */
function CategorySelect({ ticket, update }: { ticket: TicketDetail; update: TicketUpdate }) {
  return (
    <Select
      value={ticket.category ?? NO_CATEGORY}
      onValueChange={(value) => {
        if (value === NO_CATEGORY) update.mutate({ category: null })
        else if (isTicketCategory(value)) update.mutate({ category: value })
      }}
      disabled={update.isPending}
    >
      <SelectTrigger id="ticket-category" aria-label="Category" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_CATEGORY}>Uncategorised</SelectItem>
        {Object.entries(TICKET_CATEGORY_LABELS).map(([value, label]) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * Who holds this ticket. Any signed-in user may hand a ticket to anyone,
 * themselves included - the server takes the same view, and the list of
 * candidates comes from `/api/assignees` rather than the admin-only
 * `/api/users`.
 *
 * The only control with a second request behind it, which is why the failure of
 * that list is reported here rather than with the write errors below the list.
 */
function AssigneeSelect({ ticket, update }: { ticket: TicketDetail; update: TicketUpdate }) {
  const assignees = useQuery(assigneeListQueryOptions())

  return (
    <div className="flex flex-col gap-1">
      <Select
        // Radix refuses an empty value, hence the sentinel - the same device
        // the queue's "all" filters use.
        value={ticket.assignedTo?.id ?? UNASSIGNED}
        onValueChange={(value) =>
          update.mutate({ assignedToId: value === UNASSIGNED ? null : value })
        }
        disabled={assignees.isPending || update.isPending}
      >
        <SelectTrigger id="ticket-assignee" aria-label="Assigned to" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
          {assigneeOptions(assignees.data, ticket.assignedTo).map((assignee) => (
            <SelectItem key={assignee.id} value={assignee.id}>
              {assignee.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {assignees.isError && (
        <p role="alert" className="text-sm text-destructive">
          Could not load the list of people to assign to.
        </p>
      )}
    </div>
  )
}

/**
 * The options to offer, which is the assignable list plus - if it is not
 * already there - whoever currently holds the ticket. An assignee who has since
 * been deactivated has left that list, and without this the select would match
 * no option and render blank, quietly saying the ticket is unassigned when it
 * is not.
 */
function assigneeOptions(
  assignees: Assignee[] | undefined,
  current: TicketDetail['assignedTo'],
): Pick<Assignee, 'id' | 'name'>[] {
  const options = assignees ?? []
  if (current === null || options.some((assignee) => assignee.id === current.id)) return options
  return [...options, current]
}

/**
 * Says that the reply on this ticket was written from the knowledge base rather
 * than by a colleague.
 *
 * **This is the only place the automation surfaces anywhere**, which is why it
 * is worth more than a badge. The thread is deliberately silent: there is no
 * footer, and the reply is signed by the support team, because the student is
 * owed an answer rather than a disclaimer. So everything an agent needs to know
 * about where it came from has to be said here, and all three parts of it are
 * load-bearing - the reply was not written by a person, nobody reviewed it
 * before it was stored, and the student has not actually received it, because
 * nothing is emailed yet.
 *
 * On a ticket a student has replied to, the status is back to OPEN while
 * `autoResolvedAt` stays set, and the notice then reads as history. That is
 * correct: what it records is that a reply in the thread is not a colleague's,
 * which stays true however the ticket moves afterwards.
 */
function AutoResolvedNotice({ at }: { at: string | null }) {
  if (!at) return null

  return (
    <div
      role="note"
      aria-label="Answered from the knowledge base"
      className="mb-6 rounded-md border border-border bg-muted/50 p-4 text-sm"
    >
      <p className="font-medium">
        This ticket was answered from the knowledge base and resolved
        automatically on{' '}
        <time dateTime={at}>{formatDateTime(at)}</time>.
      </p>
      <p className="mt-1 text-muted-foreground">
        The reply below was written from <code>knowledge-base.md</code> rather than by a
        colleague, and no one reviewed it before it was saved. Nothing has been emailed to the
        requester. Check that it answers the question, and reply again if it does not.
      </p>
    </div>
  )
}

function MessageCard({ message }: { message: TicketMessage }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <span className="font-medium">{message.fromName}</span>{' '}
            <span className="text-sm text-muted-foreground">({message.fromEmail})</span>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={DIRECTION_VARIANTS[message.direction]}>
              {DIRECTION_LABELS[message.direction]}
            </Badge>
            <time dateTime={message.createdAt} className="text-sm text-muted-foreground">
              {formatDateTime(message.createdAt)}
            </time>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Plain text, as text. The body arrives with its line breaks intact
            and `whitespace-pre-wrap` is what keeps them; the HTML part of the
            mail is deliberately not sent to the client at all, so there is
            nothing here to sanitise. */}
        <p className="whitespace-pre-wrap break-words">{message.body}</p>
      </CardContent>
    </Card>
  )
}

/**
 * A summary of the ticket and everything said on it, on demand.
 *
 * **Nothing is stored and nothing is cached.** Every press asks the server for a
 * fresh summary, which is why this is a `useMutation` rather than a `useQuery` -
 * a query would hand back a cached answer, and a cached summary is wrong the
 * moment the next message arrives. An agent reading "waiting on a refund date"
 * would not notice the refund was paid two replies ago. So the summary lives in
 * this component's mutation state, is thrown away on navigation, and says so.
 *
 * It sits between the thread and the composer because that is the order of the
 * job: read what happened, or have it read to you, then answer.
 */
function TicketSummary({ ticket }: { ticket: TicketDetail }) {
  const summary = useMutation({ mutationFn: () => summarizeTicket(ticket.id) })

  const error = summary.error
    ? summary.error instanceof ApiError
      ? summary.error.message
      : NETWORK_ERROR
    : undefined

  // A ticket with no messages has nothing to summarise, and the server refuses
  // it too - a disabled button is the version of that refusal nobody has to read.
  // Not reachable through inbound mail, which creates a ticket and its first
  // message together.
  const hasMessages = ticket.messages.length > 0

  return (
    <section aria-label="Summary">
      <h2 className="mb-4 text-lg font-semibold tracking-tight">Summary</h2>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => summary.mutate()}
            disabled={summary.isPending || !hasMessages}
          >
            <SparklesIcon aria-hidden="true" />
            {summary.isPending
              ? 'Summarising…'
              : summary.data
                ? 'Regenerate summary'
                : 'Summarise ticket'}
          </Button>

          {/* Said out loud, because a summary that looks saved would be trusted
              later, when the thread has moved on and it is no longer true. */}
          <p className="text-sm text-muted-foreground">
            {hasMessages
              ? 'Written by AI from the conversation. Not saved - each press summarises the thread as it stands.'
              : 'There is nothing on this ticket to summarise yet.'}
          </p>
        </div>

        {/* The previous summary stays on screen while a new one is being
            written, rather than the section collapsing and the page jumping.
            `aria-busy` is what says it is going out of date. */}
        {summary.data && (
          <Card aria-busy={summary.isPending || undefined}>
            <CardContent>
              <p className="whitespace-pre-wrap break-words text-sm">{summary.data}</p>
            </CardContent>
          </Card>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </section>
  )
}

/**
 * The reply composer: one textarea and a button, at the foot of the thread.
 *
 * **It does not send mail.** There is no outbound sender yet, so the reply is
 * recorded on the ticket and the requester hears nothing - which the note in
 * the footer says in as many words, because a button labelled "Send" that
 * sends nothing is the one mistake this feature cannot afford. The wording
 * promises only what the action does, the rule the delete confirmation follows.
 *
 * react-hook-form with the shared `ticketReplySchema`, so an empty reply is
 * refused in the browser with the same sentence the server would have sent,
 * and the server validates it again as the authority. Its own mutation rather
 * than `useTicketUpdate`'s: a reply is a different request with a different
 * failure, and a refusal belongs under the composer, not in the Details card
 * on the other side of the page.
 *
 * **Polish** is a second button and a second mutation, before Add reply because
 * it comes before it in the job: write, polish, send. It sends the draft to
 * `POST /api/tickets/:id/polish`, which rewrites it with a model and stores
 * nothing, and puts the answer back in the textarea. The draft it replaced is
 * kept in state so Undo can put it back, because a button that silently
 * overwrites what somebody typed is one an agent only dares press on a draft
 * they did not care about.
 */
function ReplyComposer({ ticket }: { ticket: TicketDetail }) {
  const queryClient = useQueryClient()

  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    getValues,
    setValue,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<TicketReplyInput>({
    resolver: zodResolver(ticketReplySchema),
    // Defaulted to `''` rather than left undefined, so the textarea is never
    // uncontrolled - the rule every form here follows.
    defaultValues: { body: '' },
  })

  const mutation = useMutation({
    mutationFn: (input: TicketReplyInput) => replyToTicket(ticket.id, input),
    onSuccess: (updated) => storeTicket(queryClient, updated),
  })

  /**
   * Polishing is its own mutation with no `onSuccess` cache work to do: the
   * response is text, not a ticket, and nothing on the server changed - so there
   * is nothing to store and nothing to invalidate. The one request this page
   * makes that leaves the cache alone.
   */
  const polish = useMutation({
    mutationFn: (input: TicketReplyInput) => polishReply(ticket.id, input),
  })

  /**
   * The draft as it stood before the last polish, or `null` when there is
   * nothing to go back to. Component state rather than a form field: it is not
   * part of what gets submitted, and it is deliberately forgotten the moment the
   * reply lands - a stored reply is not something Undo should be able to rewind.
   */
  const [draftBeforePolish, setDraftBeforePolish] = useState<string | null>(null)

  const onSubmit = handleSubmit(async (values) => {
    try {
      await mutation.mutateAsync(values)
      // Cleared only once the reply is on the ticket. A refusal leaves the
      // text where it is, so nobody loses what they wrote to a failed request.
      reset({ body: '' })
      setDraftBeforePolish(null)
    } catch (err) {
      // No field of its own to blame - the body was valid enough to send - so
      // every refusal is form-level, the same treatment the dialogs give one.
      setError('root', { message: err instanceof ApiError ? err.message : NETWORK_ERROR })
    }
  })

  /**
   * Send the draft to be rewritten and put the answer in its place.
   *
   * The draft it replaced is remembered only once the request has come back: a
   * refusal leaves the textarea exactly as it was, with no Undo offered for
   * something that never happened. Refusals report through `errors.root`, the
   * same place the submit's do - it is the same textarea, and the same sentence
   * an agent needs to read.
   */
  const onPolish = async () => {
    const draft = getValues('body')
    // A previous failure is not news about this attempt.
    clearErrors('root')

    try {
      const polished = await polish.mutateAsync({ body: draft })
      setDraftBeforePolish(draft)
      // `shouldValidate` because the rewrite is what gets submitted, so it is
      // the text the schema has to be happy with - not the draft behind it.
      setValue('body', polished, { shouldDirty: true, shouldValidate: true })
    } catch (err) {
      setError('root', { message: err instanceof ApiError ? err.message : NETWORK_ERROR })
    }
  }

  /** Put the pre-polish draft back, and stop offering what has been taken. */
  const undoPolish = () => {
    if (draftBeforePolish === null) return
    setValue('body', draftBeforePolish, { shouldDirty: true, shouldValidate: true })
    setDraftBeforePolish(null)
  }

  // One flag for both requests: either in flight disables the textarea and both
  // buttons, so a reply cannot be added out from under a rewrite that is about to
  // replace it, and a rewrite cannot be asked for twice at once.
  const busy = isSubmitting || polish.isPending

  // Nothing to polish is a disabled button rather than a validation message:
  // there is no mistake to report, and asking a model to improve an empty draft
  // would be inviting it to write the reply itself.
  const hasDraft = watch('body').trim().length > 0

  return (
    <section aria-label="Reply">
      <h2 className="mb-4 text-lg font-semibold tracking-tight">Reply</h2>

      <Card>
        {/* The form carries the card's own gap, or its two sections sit flush:
            `Card` is a flex column and this element is now the child that
            would have had the spacing. */}
        <form
          noValidate
          onSubmit={(event) => void onSubmit(event)}
          className="flex flex-col gap-(--card-spacing)"
        >
          <CardContent>
            <Field data-invalid={errors.body ? true : undefined}>
              <FieldLabel htmlFor="ticket-reply">Your reply</FieldLabel>
              <Textarea
                id="ticket-reply"
                rows={6}
                disabled={busy}
                aria-invalid={errors.body ? true : undefined}
                {...register('body')}
              />
              <FieldError errors={[errors.body]} />
            </Field>

            {/* Only after a polish, and gone again the moment the draft is put
                back or the reply is added. It says what happened and that the
                result still needs reading - the model rewrote the wording, it
                did not check the answer. */}
            {draftBeforePolish !== null && (
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                <span>Rewritten from your draft. Read it before adding.</span>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto px-0"
                  onClick={undoPolish}
                  disabled={busy}
                >
                  Undo polish
                </Button>
              </div>
            )}

            {/* Rendered only when there is something to say, the way the rest
                of this page reports a refusal - an empty live region sitting
                in the page permanently is one more thing for a screen reader
                to walk past. */}
            {errors.root && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {errors.root.message}
              </p>
            )}
          </CardContent>

          <CardFooter className="flex-wrap justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              Saved on the ticket. Nothing is emailed to {ticket.requesterName} yet.
            </p>
            {/* Polish first, because it comes first in the job: write it,
                improve it, add it. `outline` rather than the default, so the
                button that actually puts the reply on the ticket stays the one
                the eye lands on. */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void onPolish()}
                disabled={busy || !hasDraft}
              >
                <SparklesIcon aria-hidden="true" />
                {polish.isPending ? 'Polishing…' : 'Polish'}
              </Button>
              <Button type="submit" disabled={busy}>
                {isSubmitting ? 'Adding…' : 'Add reply'}
              </Button>
            </div>
          </CardFooter>
        </form>
      </Card>
    </section>
  )
}

/**
 * The page's shape before the first response. Hidden from assistive technology
 * behind a `role="status"` line, and carrying none of the real content's
 * accessible names, so a test waiting for the heading cannot match it.
 */
function TicketSkeleton() {
  return (
    <div aria-busy="true">
      <p role="status" className="sr-only">
        Loading ticket…
      </p>
      {/* The same two columns as the content, so nothing jumps sideways when
          the response lands. */}
      <div aria-hidden="true">
        <Skeleton className="mb-6 h-8 w-96 max-w-full" />
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
          <div className="flex flex-col gap-4">
            {Array.from({ length: 2 }, (_, i) => (
              <Skeleton key={i} className="h-32 w-full rounded-xl" />
            ))}
            {/* The summary control and the composer are both part of the
                page's shape, so leaving them out would make the thread grow
                downwards when the response lands. */}
            <Skeleton className="mt-4 h-9 w-48 rounded-lg" />
            <Skeleton className="mt-4 h-44 w-full rounded-xl" />
          </div>
          <Skeleton className="h-80 w-full rounded-xl" />
        </div>
      </div>
    </div>
  )
}
