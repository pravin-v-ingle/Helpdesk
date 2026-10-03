/**
 * The sorting vocabulary both list pages share, and the one adapter between
 * TanStack Table's sorting state and the URL.
 *
 * `SortDir` lives here rather than beside `Role` in `api.ts`. That "an enum
 * mirror lives beside the type whose field it is" rule is about Prisma enum
 * mirrors; `SortDir` is a parameter of two list endpoints and a field of
 * neither `Ticket` nor `PublicUser`. The per-resource `sortBy` unions do follow
 * the rule - `TicketSortBy` is in `lib/tickets.ts`, `UserSortBy` in
 * `lib/users.ts` - because each names that resource's own columns.
 */
import type { OnChangeFn, SortingState } from '@tanstack/react-table'

/**
 * A const object rather than a TypeScript `enum`: the client tsconfig sets
 * `erasableSyntaxOnly`, which forbids the keyword.
 */
export const SortDir = {
  asc: 'asc',
  desc: 'desc',
} as const

export type SortDir = (typeof SortDir)[keyof typeof SortDir]

export function isSortDir(value: unknown): value is SortDir {
  return typeof value === 'string' && Object.hasOwn(SortDir, value)
}

/**
 * A column and a direction, always together. Both endpoints take the pair, and
 * the client writes both keys or neither - `undefined` is how "the resource's
 * default order" is spelled, both in the URL and on the wire.
 */
export type Sort<TKey extends string> = { sortBy: TKey; sortDir: SortDir }

/** The pair as TanStack sees it. One column at a time; `undefined` is `[]`. */
export function toSortingState<TKey extends string>(sort: Sort<TKey> | undefined): SortingState {
  return sort === undefined ? [] : [{ id: sort.sortBy, desc: sort.sortDir === SortDir.desc }]
}

/**
 * Adapts TanStack's `onSortingChange` to a single-column URL write.
 *
 * The callback is handed *either* the next state *or* an updater to apply to
 * the current one - and `getToggleSortingHandler()` always takes the updater
 * path, so resolving it against `current` is not an edge case.
 *
 * `isKey` is the one place a TanStack column id - typed as a plain `string` -
 * becomes a validated sort key. An empty `next` means sorting was removed,
 * which becomes `undefined`: the "back to the default" signal.
 */
export function sortingChangeHandler<TKey extends string>(
  current: Sort<TKey> | undefined,
  isKey: (value: unknown) => value is TKey,
  write: (next: Sort<TKey> | undefined) => void,
): OnChangeFn<SortingState> {
  return (updater) => {
    const next = typeof updater === 'function' ? updater(toSortingState(current)) : updater
    const first = next[0]
    write(
      first && isKey(first.id)
        ? { sortBy: first.id, sortDir: first.desc ? SortDir.desc : SortDir.asc }
        : undefined,
    )
  }
}
