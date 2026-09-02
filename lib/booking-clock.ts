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
 *
 * The status is here because `finished_at` is not the only way a booking ends.
 * setBookingStatus never stamps it — closing a ticket from the admin dropdown,
 * or cancelling someone who had already checked in, leaves it null forever. Read
 * off the timestamps alone this clock called those rows "running" and counted
 * up all day, so a cancelled customer sat in the desk's list reading "Running
 * for 7 h". A booking in a terminal state is over whether or not anyone stamped
 * when: with no finish time there is no honest figure to show, so it shows
 * none rather than a growing one.
 */
type ClockInput = {
  status?: string | null;
  checkedInAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
};

/** Nothing is still running in any of these, whatever the timestamps say. */
const OVER = ["completed", "cancelled", "no_show"];

export function serviceClock(
  b: ClockInput,
  now: number,
): { runningMs: number | null; tookMs: number | null } {
  const from = b.checkedInAt ?? b.startedAt;
  if (!from) return { runningMs: null, tookMs: null };

  const started = new Date(from).getTime();
  if (b.finishedAt) {
    return { runningMs: null, tookMs: Math.max(0, new Date(b.finishedAt).getTime() - started) };
  }

  if (b.status && OVER.includes(b.status)) return { runningMs: null, tookMs: null };

  return { runningMs: Math.max(0, now - started), tookMs: null };
}
