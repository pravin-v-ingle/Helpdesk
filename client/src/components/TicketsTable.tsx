import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { TicketStatus, type Ticket } from '../lib/tickets.ts'

const TABLE_COLUMNS = [
  'Subject',
  'Requester',
  'Status',
  'Category',
  'Messages',
  'Last message',
] as const
const SKELETON_ROWS = 5

/** Shown in the Category cell for a ticket the classifier has not reached. */
const UNCATEGORISED = '—'

/**
 * Human labels for the category enum, as a `Record` keyed by the union: adding a
 * category to the Prisma schema is then a compile error here until it has a
 * label, rather than a raw `REFUND_REQUEST` appearing in the table.
 */
export const TICKET_CATEGORY_LABELS: Record<NonNullable<Ticket['category']>, string> = {
  GENERAL_QUESTION: 'General question',
  TECHNICAL_QUESTION: 'Technical question',
  REFUND_REQUEST: 'Refund request',
}

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  OPEN: 'Open',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
}

/** Open is the queue, so it is the one status that stands out. */
const STATUS_VARIANTS: Record<TicketStatus, 'default' | 'secondary' | 'outline'> = {
  OPEN: 'default',
  RESOLVED: 'secondary',
  CLOSED: 'outline',
}

/**
 * The ticket queue as a table. Presentational: it is given the rows to show and
 * says nothing about where they came from, so the page owns the query, the
 * filters and the paging. `TicketsTableSkeleton` below is its loading twin and
 * shares the column set, which is why they live together.
 *
 * Rows are inert. The detail page is task 3.10; until it exists a row that
 * looked clickable would be a promise the app cannot keep.
 */
export function TicketsTable({
  tickets,
  fetching,
  emptyText,
}: {
  tickets: Ticket[]
  /** A refetch is in flight; the rows on screen may be stale. */
  fetching: boolean
  /** Shown in place of rows when `tickets` is empty. */
  emptyText: string
}) {
  return (
    // The table stays mounted while a refetch is in flight, so the page does
    // not jump; `aria-busy` is the only sign that the rows may be stale.
    <div aria-busy={fetching} className="rounded-md border">
      <Table aria-label="Tickets">
        <TableHeader>
          <TableRow>
            {TABLE_COLUMNS.map((column) => (
              <TableHead key={column} className={column === 'Messages' ? 'text-right' : undefined}>
                {column}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {tickets.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={TABLE_COLUMNS.length}
                className="text-center text-muted-foreground"
              >
                {emptyText}
              </TableCell>
            </TableRow>
          ) : (
            tickets.map((ticket) => (
              <TableRow key={ticket.id}>
                <TableCell className="font-medium">{ticket.subject}</TableCell>
                <TableCell>
                  {/* The name reads first; the address is what an agent needs
                      when they come to reply. */}
                  <span className="block">{ticket.requesterName}</span>
                  <span className="block text-sm text-muted-foreground">
                    {ticket.requesterEmail}
                  </span>
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANTS[ticket.status]}>
                    {TICKET_STATUS_LABELS[ticket.status]}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {/* An em dash, not "Uncategorised": the absence is the point,
                      and every ticket shows it until Phase 5 lands. */}
                  {ticket.category === null ? (
                    UNCATEGORISED
                  ) : (
                    <Badge variant="secondary">{TICKET_CATEGORY_LABELS[ticket.category]}</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{ticket.messageCount}</TableCell>
                <TableCell className="text-muted-foreground">
                  <time dateTime={ticket.lastMessageAt}>
                    {new Date(ticket.lastMessageAt).toLocaleDateString(undefined, {
                      dateStyle: 'medium',
                    })}
                  </time>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}

/**
 * The table's shape before the first response: real headers, placeholder cells
 * sized like the content they stand in for. Hidden from assistive technology -
 * the status text beside it says what is happening - and not named "Tickets",
 * so nothing mistakes it for the table it precedes.
 */
export function TicketsTableSkeleton() {
  return (
    <div aria-busy="true" className="rounded-md border">
      <p role="status" className="sr-only">
        Loading tickets…
      </p>
      <Table aria-hidden="true">
        <TableHeader>
          <TableRow>
            {TABLE_COLUMNS.map((column) => (
              <TableHead key={column}>{column}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <TableRow key={i}>
              <TableCell>
                <Skeleton className="h-4 w-48" />
              </TableCell>
              <TableCell>
                {/* Two lines, like the requester cell it stands in for. */}
                <Skeleton className="h-4 w-28" />
                <Skeleton className="mt-1 h-3 w-40" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-5 w-16 rounded-full" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-5 w-28 rounded-full" />
              </TableCell>
              <TableCell className="text-right">
                <Skeleton className="ml-auto h-4 w-6" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-24" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
