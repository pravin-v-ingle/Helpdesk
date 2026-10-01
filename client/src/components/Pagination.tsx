import { Button } from '@/components/ui/button'

/**
 * Previous/Next paging for a list page, with the range and page counters
 * beside it. Presentational: it is told where it is and how much there is,
 * and reports a page change back. The page owns the URL state.
 *
 * `total` and `count` are separate because they answer different questions -
 * how many rows match the filters, and how many are on this page - and the
 * "Showing 1–20 of 57" line needs both. A page past the end has `count: 0`
 * with a real `total`, and shows an empty range rather than a wrong one.
 */
export function Pagination({
  page,
  pageSize,
  total,
  count,
  fetching,
  onPageChange,
}: {
  /** 1-based. */
  page: number
  pageSize: number
  /** Rows matching the filters, across every page. */
  total: number
  /** Rows on this page. */
  count: number
  /** A request is in flight; both buttons are held until it settles. */
  fetching: boolean
  onPageChange: (page: number) => void
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const from = (page - 1) * pageSize + 1
  const to = from + count - 1

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-4 text-sm text-muted-foreground">
      <p aria-live="polite">
        Showing {from}–{to} of {total}
      </p>
      <div className="flex items-center gap-3">
        <span>
          Page {page} of {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={fetching || page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={fetching || page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  )
}
