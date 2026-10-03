import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import { cn } from 'cn'
import { TableHead } from '@/components/ui/table'

/**
 * One column header, sortable or not. The repo's single header idiom: both
 * list tables build their header row out of these.
 *
 * It takes plain scalars rather than a TanStack `Header`. A wrapper generic
 * over a feature set and a row type would mean getting v9's three-parameter
 * generics and their variance right in our own checked code - the likeliest
 * place in this change to fight the compiler - and buys nothing a `.map` in
 * each table does not already give. So no TanStack type reaches this file.
 */
export function SortableHead({
  label,
  sortable,
  sorted,
  onToggle,
  align,
}: {
  label: string
  /** False renders the bare label: no button, and no `aria-sort` at all. */
  sortable: boolean
  /** TanStack's `getIsSorted()`: a direction, or `false` for unsorted. */
  sorted: 'asc' | 'desc' | false
  /** TanStack's `getToggleSortingHandler()`, which is undefined when it cannot sort. */
  onToggle: ((event: unknown) => void) | undefined
  /** Matches the cell's alignment, so the two cannot drift apart. */
  align?: 'right'
}) {
  // A column that cannot be sorted gets no `aria-sort` attribute, rather than
  // `"none"`: `"none"` would claim Actions is a sortable column that happens
  // to be unsorted at the moment.
  if (!sortable) {
    return <TableHead className={align === 'right' ? 'text-right' : undefined}>{label}</TableHead>
  }

  const Icon = sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ChevronsUpDown

  return (
    // `aria-sort` belongs on the `<th>`, which is where ARIA puts it - not on
    // the button inside it. `TableHead` is a plain `<th>` that spreads its
    // props, so it passes straight through and shadcn's generated directory is
    // left alone.
    <TableHead
      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
      className={align === 'right' ? 'text-right' : undefined}
    >
      {/*
        The button's only text node is the label, and it must stay that way.
        Three assertions across two test frameworks compare header
        `textContent` against the exact column label, so the direction is shown
        by an `aria-hidden` icon plus the `aria-sort` above - never a text
        glyph, never visually hidden state text, never a `title`.

        A plain `<button>`, not a Radix primitive: none of the jsdom
        pointer-capture gotchas apply and `user.click` works first time.
      */}
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'flex items-center gap-1 rounded px-2 py-1 font-medium hover:text-foreground/80 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
          // The negative margin cancels the padding above, so the label still
          // lines up with the cells below it. Only the outer edge is pulled
          // back on a right-aligned column, because `ml-auto` owns that side.
          align === 'right' ? '-mr-2 ml-auto' : '-ml-2',
        )}
      >
        {label}
        <Icon
          aria-hidden="true"
          className={`size-3.5 ${sorted === false ? 'text-muted-foreground/50' : ''}`}
        />
      </button>
    </TableHead>
  )
}
