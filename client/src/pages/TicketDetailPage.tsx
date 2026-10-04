import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { TICKET_CATEGORY_LABELS, TICKET_STATUS_LABELS } from '../components/TicketsTable.tsx'
import { ApiError } from '../lib/api.ts'
import { assigneeListQueryOptions, type Assignee } from '../lib/assignees.ts'
import {
  assignTicket,
  MessageDirection,
  ticketDetailQueryOptions,
  ticketKeys,
  type TicketDetail,
  type TicketMessage,
} from '../lib/tickets.ts'

const NETWORK_ERROR = 'Could not reach the server. Please try again.'

/** The same message the server sends for a 404, shown for an unusable id too. */
const NOT_FOUND = 'Ticket not found'

/** What the Category line shows for a ticket the classifier has not reached. */
const UNCATEGORISED = '—'

/** The assignee select's "nobody" option. Radix refuses an empty value. */
const UNASSIGNED = 'unassigned'

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
 * Assignment is the one thing this page writes (`AssigneeSelect` below). The
 * status and category controls are task 3.11 and the reply composer 3.12; both
 * belong here, which is why the header leaves room beside the badges.
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
  return (
    <>
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">{ticket.subject}</h1>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge>{TICKET_STATUS_LABELS[ticket.status]}</Badge>
          {ticket.category === null ? (
            <span className="text-sm text-muted-foreground">{UNCATEGORISED}</span>
          ) : (
            <Badge variant="secondary">{TICKET_CATEGORY_LABELS[ticket.category]}</Badge>
          )}
        </div>

        {/* A description list rather than prose: each fact has a label an
            assistive technology can read with its value. */}
        <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr] sm:gap-y-1">
          <dt className="text-muted-foreground">Requester</dt>
          <dd>
            {ticket.requesterName}{' '}
            <span className="text-muted-foreground">({ticket.requesterEmail})</span>
          </dd>

          <dt className="text-muted-foreground">Assigned to</dt>
          {/* Every ticket arrives unassigned - inbound mail names no one to
              give it to - so Unassigned is the normal state, not an edge. */}
          <dd>
            <AssigneeSelect ticket={ticket} />
          </dd>

          <dt className="text-muted-foreground">Opened</dt>
          <dd>
            <time dateTime={ticket.createdAt}>{formatDateTime(ticket.createdAt)}</time>
          </dd>

          <dt className="text-muted-foreground">Last message</dt>
          <dd>
            <time dateTime={ticket.lastMessageAt}>{formatDateTime(ticket.lastMessageAt)}</time>
          </dd>
        </dl>
      </header>

      <section aria-label="Messages">
        <h2 className="mb-4 text-lg font-semibold tracking-tight">
          Messages ({ticket.messageCount})
        </h2>

        {ticket.messages.length === 0 ? (
          // Not reachable through the inbound path, which creates a ticket and
          // its first message together - but a page that renders nothing at all
          // would be indistinguishable from one that failed.
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
    </>
  )
}

/**
 * Who holds this ticket, as a control. Any signed-in user may hand a ticket to
 * anyone, themselves included - the server takes the same view, and the list of
 * candidates comes from `/api/assignees` rather than the admin-only
 * `/api/users`.
 *
 * The write returns the whole ticket, which is written straight into the detail
 * query's cache: no refetch, and no second shape to keep in step. The ticket
 * list carries no assignee column, so nothing there needs invalidating.
 */
function AssigneeSelect({ ticket }: { ticket: TicketDetail }) {
  const queryClient = useQueryClient()
  const assignees = useQuery(assigneeListQueryOptions())

  const mutation = useMutation({
    mutationFn: (assignedToId: string | null) => assignTicket(ticket.id, assignedToId),
    onSuccess: (updated) => {
      queryClient.setQueryData(ticketKeys.detail(updated.id), updated)
    },
  })

  const error = mutation.error
    ? mutation.error instanceof ApiError
      ? mutation.error.message
      : NETWORK_ERROR
    : undefined

  return (
    <div className="flex flex-col gap-1">
      <Select
        // Radix refuses an empty value, hence the sentinel - the same device
        // the queue's "all" filters use.
        value={ticket.assignedTo?.id ?? UNASSIGNED}
        // The value shown is the ticket's, so a refused change goes back to
        // who actually holds it as soon as the server says no.
        onValueChange={(value) => mutation.mutate(value === UNASSIGNED ? null : value)}
        disabled={assignees.isPending || mutation.isPending}
      >
        <SelectTrigger id="ticket-assignee" aria-label="Assigned to" className="w-60">
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
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
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
      <div aria-hidden="true">
        <Skeleton className="h-8 w-96 max-w-full" />
        <Skeleton className="mt-3 h-5 w-20 rounded-full" />
        <div className="mt-4 flex flex-col gap-2">
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="mt-8 flex flex-col gap-4">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  )
}
