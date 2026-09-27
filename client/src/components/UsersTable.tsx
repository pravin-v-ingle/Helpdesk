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
import { Role, type PublicUser } from '../lib/api.ts'
import { EditUserDialog } from './EditUserDialog.tsx'

const TABLE_COLUMNS = ['Name', 'Email', 'Role', 'Status', 'Created', 'Actions'] as const
const SKELETON_ROWS = 5

/**
 * The admin user list as a table. Presentational: it is given the rows to
 * show and says nothing about where they came from, so the page owns the
 * query, the filters and the paging. The one exception is the Actions column's
 * `EditUserDialog`, which owns its own mutation and invalidates the list
 * itself. `UsersTableSkeleton` below is its loading twin and shares the column
 * set, which is why they live together.
 */
export function UsersTable({
  users,
  currentUserId,
  fetching,
  emptyText,
}: {
  users: PublicUser[]
  /** Marks the signed-in admin's own row "(you)". */
  currentUserId: string | undefined
  /** A refetch is in flight; the rows on screen may be stale. */
  fetching: boolean
  /** Shown in place of rows when `users` is empty. */
  emptyText: string
}) {
  return (
    // The table stays mounted while a refetch is in flight, so the page does
    // not jump; `aria-busy` is the only sign that the rows may be stale.
    <div aria-busy={fetching} className="rounded-md border">
      <Table aria-label="Users">
        <TableHeader>
          <TableRow>
            {TABLE_COLUMNS.map((column) => (
              <TableHead key={column} className={column === 'Actions' ? 'text-right' : undefined}>
                {column}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.length === 0 ? (
            <TableRow>
              <TableCell colSpan={TABLE_COLUMNS.length} className="text-center text-muted-foreground">
                {emptyText}
              </TableCell>
            </TableRow>
          ) : (
            users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium">
                  {user.name}
                  {user.id === currentUserId && (
                    <span className="text-muted-foreground"> (you)</span>
                  )}
                </TableCell>
                <TableCell>{user.email}</TableCell>
                <TableCell>
                  <Badge variant={user.role === Role.ADMIN ? 'default' : 'secondary'}>
                    {user.role === Role.ADMIN ? 'Admin' : 'Agent'}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={user.active ? 'outline' : 'destructive'}>
                    {user.active ? 'Active' : 'Inactive'}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <time dateTime={user.createdAt}>
                    {new Date(user.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
                  </time>
                </TableCell>
                <TableCell className="text-right">
                  <EditUserDialog user={user} />
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
 * The table's shape before the first response: real headers, placeholder
 * cells sized like the content they stand in for. Hidden from assistive
 * technology - the status text beside it says what is happening - and not
 * named "Users", so nothing mistakes it for the table it precedes.
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
            {TABLE_COLUMNS.map((column) => (
              <TableHead key={column}>{column}</TableHead>
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
                <Skeleton className="ml-auto size-8" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
