// When two appointments collide, and who is therefore not free.
//
// One definition, used by the assignment engine (lib/assign), the front desk and
// the floor screen. Three places deciding separately what "busy" means is how a
// technician ends up greyed out on one screen and handed a second customer by
// another.
//
// Pure and client-safe on purpose: the two screens already hold the whole day,
// so they answer this themselves rather than asking the server per row.

/**
 * Do these two spans collide?
 *
 * Half-open — a span ending exactly when another starts does *not* collide.
 * 10:00–11:00 and 11:00–12:00 are back-to-back, which is how a chair is meant to
 * be used, and treating that as a clash would idle half the floor.
 */
export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** The least a row needs for the question below to be answerable. */
export type SlotRow = {
  id: string;
  technicianId: string | null;
  startsAt: string;
  endsAt: string;
  status: string;
};

/**
 * A cancelled, closed, or no-show booking holds nobody.
 *
 * `no_show` belongs here for the same reason as the other two, and was missed:
 * sweepNoShows has already given the chair back by the time a row reaches this
 * status, so a technician reading as busy for an hour nobody is sitting in is
 * the screen contradicting the scheduler. It made the desk pick around a
 * technician who was free.
 */
function occupies(status: string): boolean {
  return status !== "cancelled" && status !== "completed" && status !== "no_show";
}

/**
 * Who already has work across this booking's hours.
 *
 * "Busy" is a fact about a slot, not about a person: what matters when moving a
 * 17:00 booking is who is free *at 17:00*, not who happens to be holding a
 * customer while the receptionist looks at the screen.
 *
 * The booking itself is excluded, or its own technician would always come back
 * as unavailable for the row she is already on.
 */
export function busyDuring(rows: SlotRow[], span: SlotRow): Set<string> {
  const from = new Date(span.startsAt);
  const to = new Date(span.endsAt);

  return new Set(
    rows
      .filter(
        (r) =>
          r.id !== span.id &&
          r.technicianId &&
          occupies(r.status) &&
          overlaps(from, to, new Date(r.startsAt), new Date(r.endsAt)),
      )
      .map((r) => r.technicianId as string),
  );
}
