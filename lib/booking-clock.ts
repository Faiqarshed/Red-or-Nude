/**
 * How long the customer has been in the salon — check-in to finish.
 *
 * The desk's clock, not the technician's. `started_at → finished_at` is the
 * work, and /admin/performance and the technician's own screens read it that
 * way because her commission is measured on it; this is the visit, wait
 * included, which is what the receptionist is actually being asked about.
 *
 * Falls back to `started_at` for a walk-in pushed straight to `in_progress`
 * with no check-in stamp. `tookMs` settles at Finish and stops climbing while
 * the ticket waits to be closed; exactly one of the two is ever non-null.
 */
type ClockInput = {
  checkedInAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
};

export function serviceClock(
  b: ClockInput,
  now: number,
): { runningMs: number | null; tookMs: number | null } {
  const from = b.checkedInAt ?? b.startedAt;
  if (!from) return { runningMs: null, tookMs: null };

  const to = b.finishedAt ? new Date(b.finishedAt).getTime() : now;
  const ms = Math.max(0, to - new Date(from).getTime());
  return b.finishedAt ? { runningMs: null, tookMs: ms } : { runningMs: ms, tookMs: null };
}
