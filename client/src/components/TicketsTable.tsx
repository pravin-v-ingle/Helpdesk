import {
  createColumnHelper,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortableHead } from "./SortableHead.tsx";
import {
  sortingChangeHandler,
  toSortingState,
  type Sort,
  type SortDir,
} from "../lib/sorting.ts";
import {
  isTicketSortBy,
  TicketStatus,
  type Ticket,
  type TicketSortBy,
} from "../lib/tickets.ts";

const SKELETON_ROWS = 5;

/**
 * The columns, in the order they are shown. Keyed by `TicketSortBy`, so the
 * column set and the sort vocabulary are the same set by construction: adding
 * a sortable column to the API is a compile error here until it has a label,
 * and no column can exist that the server cannot order by. The key order
 * doubles as the column order, the device `STATUS_VARIANTS` below already uses.
 */
const COLUMN_LABELS: Record<TicketSortBy, string> = {
  subject: "Subject",
  requesterName: "Requester",
  status: "Status",
  category: "Category",
  messageCount: "Messages",
  lastMessageAt: "Last message",
};

const COLUMN_ALIGN: Partial<Record<string, "right">> = {
  messageCount: "right",
};

const CELL_CLASSES: Partial<Record<string, string>> = {
  subject: "font-medium",
  category: "text-muted-foreground",
  messageCount: "text-right tabular-nums",
  lastMessageAt: "text-muted-foreground",
};

/** Shown in the Category cell for a ticket the classifier has not reached. */
const UNCATEGORISED = "—";

/**
 * Human labels for the category enum, as a `Record` keyed by the union: adding a
 * category to the Prisma schema is then a compile error here until it has a
 * label, rather than a raw `REFUND_REQUEST` appearing in the table.
 */
export const TICKET_CATEGORY_LABELS: Record<
  NonNullable<Ticket["category"]>,
  string
> = {
  GENERAL_QUESTION: "General question",
  TECHNICAL_QUESTION: "Technical question",
  REFUND_REQUEST: "Refund request",
};

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  OPEN: "Open",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

/** Open is the queue, so it is the one status that stands out. */
const STATUS_VARIANTS: Record<
  TicketStatus,
  "default" | "secondary" | "outline"
> = {
  OPEN: "default",
  RESOLVED: "secondary",
  CLOSED: "outline",
};

/**
 * `rowSortingFeature` supplies the sorting state and APIs. Omitting
 * `sortedRowModel` is exactly what makes the sorting manual - see
 * `manualSorting` below. No pagination feature either: `Pagination.tsx` and
 * the server own paging between them.
 */
const features = tableFeatures({ rowSortingFeature });
const helper = createColumnHelper<typeof features, Ticket>();

/**
 * The cell renderers live in the column defs, which is what makes a
 * label-order / cell-order mismatch structurally impossible rather than merely
 * currently-true.
 *
 * `sortDescFirst` is set explicitly on every column rather than left to
 * TanStack's type sniffing, which the v9 docs warn misjudges nullable columns -
 * and `category` is null on every row until the Phase 5 classifier runs.
 */
const columns = helper.columns([
  helper.accessor("subject", {
    header: COLUMN_LABELS.subject,
    sortDescFirst: false,
    cell: ({ row }) => (
      // The subject is the way in to the ticket, and the only one: a whole
      // clickable row would have no accessible name and nothing to put a
      // keyboard focus on. A real `<a href>`, so the browser's own
      // middle-click, Ctrl-click and "copy link" all work.
      <Link to={`/tickets/${row.original.id}`} className="link font-medium">
        {row.original.subject}
      </Link>
    ),
  }),
  helper.accessor("requesterName", {
    header: COLUMN_LABELS.requesterName,
    sortDescFirst: false,
    cell: ({ row }) => (
      <>
        {/* The name reads first; the address is what an agent needs when they
            come to reply. The header sorts by the name for the same reason -
            a header reading "Requester" must order by what the eye lands on. */}
        <span className="block">{row.original.requesterName}</span>
        <span className="block text-sm text-muted-foreground">
          {row.original.requesterEmail}
        </span>
      </>
    ),
  }),
  helper.accessor("status", {
    header: COLUMN_LABELS.status,
    sortDescFirst: false,
    cell: ({ row }) => (
      <Badge variant={STATUS_VARIANTS[row.original.status]}>
        {TICKET_STATUS_LABELS[row.original.status]}
      </Badge>
    ),
  }),
  helper.accessor("category", {
    header: COLUMN_LABELS.category,
    sortDescFirst: false,
    cell: ({ row }) =>
      // An em dash, not "Uncategorised": the absence is the point, and every
      // ticket shows it until Phase 5 lands.
      row.original.category === null ? (
        UNCATEGORISED
      ) : (
        <Badge variant="secondary">
          {TICKET_CATEGORY_LABELS[row.original.category]}
        </Badge>
      ),
  }),
  helper.accessor("messageCount", {
    header: COLUMN_LABELS.messageCount,
    sortDescFirst: true,
  }),
  helper.accessor("lastMessageAt", {
    header: COLUMN_LABELS.lastMessageAt,
    sortDescFirst: true,
    cell: ({ row }) => (
      <time dateTime={row.original.lastMessageAt}>
        {new Date(row.original.lastMessageAt).toLocaleDateString(undefined, {
          dateStyle: "medium",
        })}
      </time>
    ),
  }),
]);

/**
 * The ticket queue as a table. Presentational: it is given the rows to show and
 * says nothing about where they came from, so the page owns the query, the
 * filters, the paging and the URL. `TicketsTableSkeleton` below is its loading
 * twin and derives its headers from `COLUMN_LABELS`, which is why they live
 * together.
 *
 * TanStack Table owns the column model, the header state and the toggle cycle;
 * the database owns the order. Nothing is re-sorted in the browser - the rows
 * are rendered in exactly the order they arrived.
 *
 * The subject cell is a link to `/tickets/:id`; the rest of the row is inert.
 * Being a link rather than a row-wide click handler is what makes the detail
 * page reachable from the keyboard and openable in a new tab.
 */
export function TicketsTable({
  tickets,
  sortBy,
  sortDir,
  onSortChange,
  fetching,
  emptyText,
}: {
  tickets: Ticket[];
  /**
   * The effective sort - the page resolves the default before passing it, so
   * a bare `/tickets` shows Last message as descending rather than as unsorted.
   */
  sortBy: TicketSortBy;
  sortDir: SortDir;
  /** `undefined` means "back to the default", which the page stores as absent. */
  onSortChange: (next: Sort<TicketSortBy> | undefined) => void;
  /** A refetch is in flight; the rows on screen may be stale. */
  fetching: boolean;
  /** Shown in place of rows when `tickets` is empty. */
  emptyText: string;
}) {
  const sort = { sortBy, sortDir };

  const table = useTable({
    features,
    columns,
    data: tickets,
    // Trust the incoming order and apply none. With no `sortedRowModel`
    // registered there is nothing to re-sort with, so this is belt and braces -
    // deliberately, because a row model added later would otherwise start
    // silently reordering the server's page.
    manualSorting: true,
    enableMultiSort: false,
    // Controlled, derived from the URL: the page is the only owner of this
    // state, and a toggle is a URL write that comes back round as new props.
    state: { sorting: toSortingState(sort) },
    onSortingChange: sortingChangeHandler(sort, isTicketSortBy, onSortChange),
    // Without this React keys rows by index, so a re-sort would reuse DOM
    // nodes across semantically different rows.
    getRowId: (row) => String(row.id),
  });

  return (
    // The table stays mounted while a refetch is in flight, so the page does
    // not jump; `aria-busy` is the only sign that the rows may be stale.
    <div aria-busy={fetching} className="rounded-md border">
      <Table aria-label="Tickets">
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                // The label comes from `COLUMN_LABELS` rather than
                // `FlexRender`, which keeps the button's children a single
                // string - slightly less idiomatic, considerably safer against
                // the rule that a header's text is exactly its column label.
                <SortableHead
                  key={header.id}
                  label={COLUMN_LABELS[header.column.id as TicketSortBy]}
                  sortable={header.column.getCanSort()}
                  sorted={header.column.getIsSorted()}
                  onToggle={header.column.getToggleSortingHandler()}
                  align={COLUMN_ALIGN[header.column.id]}
                />
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {tickets.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={Object.keys(COLUMN_LABELS).length}
                className="text-center text-muted-foreground"
              >
                {emptyText}
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getAllCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    className={CELL_CLASSES[cell.column.id]}
                  >
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * The table's shape before the first response: real headers, placeholder cells
 * sized like the content they stand in for. Hidden from assistive technology -
 * the status text beside it says what is happening - and not named "Tickets",
 * so nothing mistakes it for the table it precedes.
 *
 * Plain `<th>`s with no buttons and no `aria-sort`: nothing here may be
 * interacted with. The labels come from `COLUMN_LABELS`, so the two header
 * rows stay in step by construction rather than being two lists that can drift.
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
            {Object.values(COLUMN_LABELS).map((label) => (
              <TableHead key={label}>{label}</TableHead>
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
  );
}
