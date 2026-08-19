// The cancellation window rule (brief §2.6). One function, two callers: the
// booking history uses it to decide whether to show the Cancel and Reschedule
// buttons, and the API routes use it to decide whether to honour the request.
//
// Deliberately pure and dependency-free — no database, no `server-only` — for
// the same reason lib/refill.ts is: the customer's screen and the server must
// never disagree about whether a window is still open. A rule copied into a UI
// is a rule that drifts.

export type CancelInput = {
  /** When the appointment starts. The window counts back from here. */
  startsAt: Date;
  status: string;
};

const HOUR_MS = 3_600_000;

/**
 * Statuses a customer may still act on.
 *
 * `pending` is included on purpose: an unpaid hold is abandoned by walking
 * away, but a customer who explicitly cancels should not have to wait out
 * `booking_hold_min` to see it gone from their history.
 *
 * Everything else is closed to them — `in_progress` means they are in the chair
 * (that is the salon's call, not a self-service one), and `completed`,
 * `cancelled` and `no_show` have nothing left to cancel.
 */
const OPEN_STATUSES = new Set(["pending", "confirmed"]);

/**
 * The moment the customer loses control of the booking: `cutoffHours` before it
 * starts.
 *
 * Exported because the deadline has two jobs and they must not disagree —
 * deciding whether the buttons show, and telling the customer *by when*. A
 * countdown computed separately from the gate is a countdown that lies.
 */
export function cancelDeadline(b: CancelInput, cutoffHours: number): Date {
  return new Date(b.startsAt.getTime() - cutoffHours * HOUR_MS);
}

/**
 * Why this booking is not the customer's to cancel or move, or `null` if it is.
 *
 * The reason is separated from the answer because the API reports it: telling
 * someone who already cancelled that their "window has closed" is a lie that
 * sends them looking for a deadline problem they do not have.
 */
export type CancelRefusal =
  /** Already cancelled or marked no-show — there is nothing left to release. */
  | "already-cancelled"
  /** In the chair, or finished. Real, but the salon's to undo, not theirs. */
  | "not-cancellable"
  /** Open, but inside `cutoffHours` of the appointment. */
  | "window-closed";

export function cancelRefusal(
  b: CancelInput,
  cutoffHours: number,
  now: Date = new Date(),
): CancelRefusal | null {
  if (b.status === "cancelled" || b.status === "no_show") return "already-cancelled";
  if (!OPEN_STATUSES.has(b.status)) return "not-cancellable";
  // Strictly before: standing exactly on the deadline is too late, so a booking
  // is never cancellable and uncancellable in the same millisecond.
  if (now.getTime() >= cancelDeadline(b, cutoffHours).getTime()) return "window-closed";
  return null;
}

/**
 * Whether this booking can still be cancelled or moved by its own customer.
 *
 * One rule serves both actions: the brief gives them the same window, and a
 * reschedule is a cancel plus a rebook as far as the freed chair is concerned.
 */
export function canCancel(b: CancelInput, cutoffHours: number, now: Date = new Date()): boolean {
  return cancelRefusal(b, cutoffHours, now) === null;
}
