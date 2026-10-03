import {
  createColumnHelper,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import { useMemo } from 'react'
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
import { SortableHead } from './SortableHead.tsx'
import { DeleteUserDialog } from './DeleteUserDialog.tsx'
import { EditUserDialog } from './EditUserDialog.tsx'
import { Role, type PublicUser } from '../lib/api.ts'
import { sortingChangeHandler, toSortingState, type Sort } from '../lib/sorting.ts'
import { isUserSortBy, type UserSortBy } from '../lib/users.ts'

const SKELETON_ROWS = 5

/**
 * The columns, in the order they are shown. Keyed by `UserSortBy` plus the one
 * column that is not a column of anything, so adding a sortable column to the
 * API is a compile error here until it has a label. The key order doubles as
 * the column order.
 */
const COLUMN_LABELS: Record<UserSortBy | 'actions', string> = {
  name: 'Name',
  email: 'Email',
  role: 'Role',
  status: 'Status',
  createdAt: 'Created',
  actions: 'Actions',
}

const COLUMN_ALIGN: Partial<Record<string, 'right'>> = { actions: 'right' }

const CELL_CLASSES: Partial<Record<string, string>> = {
  name: 'font-medium',
  createdAt: 'text-muted-foreground',
  actions: 'text-right',
}

/** See the note in `TicketsTable.tsx`: no sorted row model is what makes it manual. */
const features = tableFeatures({ rowSortingFeature })
const helper = createColumnHelper<typeof features, PublicUser>()

/**
 * The column defs, which carry the cell renderers - so a label-order /
 * cell-order mismatch is structurally impossible rather than merely
 * currently-true.
 *
 * Built inside the component rather than at module scope, unlike
 * `TicketsTable`'s: the Name and Actions cells both need `currentUserId`,
 * which is a prop. The `useMemo` is what keeps the column model stable
 * between renders.
 *
 * `sortDescFirst` is set explicitly on every column rather than left to
 * TanStack's type sniffing, which the v9 docs warn misjudges nullable columns.
 */
function useUserColumns(currentUserId: string | undefined) {
  return useMemo(
    () =>
      helper.columns([
        helper.accessor('name', {
          header: COLUMN_LABELS.name,
          sortDescFirst: false,
          cell: ({ row }) => (
            <>
              {row.original.name}
              {row.original.id === currentUserId && (
                <span className="text-muted-foreground"> (you)</span>
              )}
            </>
          ),
        }),
        helper.accessor('email', { header: COLUMN_LABELS.email, sortDescFirst: false }),
        helper.accessor('role', {
          header: COLUMN_LABELS.role,
          sortDescFirst: false,
          cell: ({ row }) => (
            <Badge variant={row.original.role === Role.ADMIN ? 'default' : 'secondary'}>
              {row.original.role === Role.ADMIN ? 'Admin' : 'Agent'}
            </Badge>
          ),
        }),
        // Status is derived from `active` plus `deletedAt` rather than stored,
        // so it needs an accessor function to exist as a column at all - and a
        // column with no accessor cannot be sorted. The value it returns is
        // never read: the server does the ordering, by both columns at once.
        helper.accessor((user) => user.active, {
          id: 'status',
          header: COLUMN_LABELS.status,
          // Descending first, so one click gives Active -> Inactive -> Deleted.
          sortDescFirst: true,
          cell: ({ row }) =>
            // Three states, and a deletion outranks the deactivation that
            // always comes with it.
            row.original.deletedAt !== null ? (
              <Badge variant="destructive">Deleted</Badge>
            ) : (
              <Badge variant={row.original.active ? 'outline' : 'secondary'}>
                {row.original.active ? 'Active' : 'Inactive'}
              </Badge>
            ),
        }),
        helper.accessor('createdAt', {
          header: COLUMN_LABELS.createdAt,
          sortDescFirst: true,
          cell: ({ row }) => (
            <time dateTime={row.original.createdAt}>
              {new Date(row.original.createdAt).toLocaleDateString(undefined, {
                dateStyle: 'medium',
              })}
            </time>
          ),
        }),
        // A display column: no accessor, so TanStack will not offer it as a
        // sort, which is right - Actions is not a column of anything.
        helper.display({
          id: 'actions',
          header: COLUMN_LABELS.actions,
          cell: ({ row }) => (
            <div className="flex justify-end gap-1">
              <EditUserDialog user={row.original} />
              {/* The server refuses to delete an admin outright, so no
                  button is offered for one. Demoting comes first. */}
              {row.original.role !== Role.ADMIN && <DeleteUserDialog user={row.original} />}
            </div>
          ),
        }),
      ]),
    [currentUserId],
  )
}

/**
 * The admin user list as a table. Presentational: it is given the rows to
 * show and says nothing about where they came from, so the page owns the
 * query, the filters, the paging and the URL. The one exception is the Actions
 * column's dialogs, which own their own mutations and invalidate the list
 * themselves. `UsersTableSkeleton` below is its loading twin and derives its
 * headers from `COLUMN_LABELS`, which is why they live together.
 *
 * TanStack Table owns the column model, the header state and the toggle cycle;
 * the database owns the order. Nothing is re-sorted in the browser.
 */
export function UsersTable({
  users,
  currentUserId,
  sort,
  onSortChange,
  fetching,
  emptyText,
}: {
  users: PublicUser[]
  /** Marks the signed-in admin's own row "(you)". */
  currentUserId: string | undefined
  /**
   * `undefined` is the default order - a composite of `active` and `createdAt`
   * that no single column describes, so on a bare `/users` no header shows as
   * sorted. Unlike the ticket queue, whose default *is* a column sort.
   */
  sort: Sort<UserSortBy> | undefined
  onSortChange: (next: Sort<UserSortBy> | undefined) => void
  /** A refetch is in flight; the rows on screen may be stale. */
  fetching: boolean
  /** Shown in place of rows when `users` is empty. */
  emptyText: string
}) {
  const columns = useUserColumns(currentUserId)

  const table = useTable({
    features,
    columns,
    data: users,
    // Trust the incoming order and apply none - see `TicketsTable.tsx`.
    manualSorting: true,
    enableMultiSort: false,
    state: { sorting: toSortingState(sort) },
    onSortingChange: sortingChangeHandler(sort, isUserSortBy, onSortChange),
    getRowId: (row) => row.id,
  })

  return (
    // The table stays mounted while a refetch is in flight, so the page does
    // not jump; `aria-busy` is the only sign that the rows may be stale.
    <div aria-busy={fetching} className="rounded-md border">
      <Table aria-label="Users">
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                // The label comes from `COLUMN_LABELS` rather than
                // `FlexRender`, which keeps the button's children a single
                // string - see the same note in `TicketsTable.tsx`.
                <SortableHead
                  key={header.id}
                  label={COLUMN_LABELS[header.column.id as UserSortBy | 'actions']}
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
          {users.length === 0 ? (
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
                  <TableCell key={cell.id} className={CELL_CLASSES[cell.column.id]}>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}

/**
 * The table's shape before the first response: real headers, placeholder
 * cells sized like the content they stand in for. Hidden from assistive
 * technology - the status text beside it says what is happening - and not
 * named "Users", so nothing mistakes it for the table it precedes.
 *
 * Plain `<th>`s with no buttons and no `aria-sort`: nothing here may be
 * interacted with. The labels come from `COLUMN_LABELS`, so the two header
 * rows stay in step by construction.
 */
export function UsersTableSkeleton() {
  return (
    <div aria-busy="true" className="rounded-md border">
      <p role="status" className="sr-only">
        Loading users…
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
                <Skeleton className="h-4 w-28" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-44" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-5 w-14 rounded-full" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-5 w-16 rounded-full" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-24" />
              </TableCell>
              <TableCell className="text-right">
                {/* Stands in for the edit and delete buttons together. */}
                <Skeleton className="ml-auto h-8 w-[4.25rem]" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
