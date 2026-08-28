// Handing customers to technicians (brief §3.1, §3.2).
//
// Two ways in, one rule underneath:
//
//   assignDay()       — the whole day dealt out before the salon opens
//   pickTechnician()  — one customer, at the moment she checks in
//
// The second is the fallback for anything the first didn't cover: a walk-in, a
// booking taken after the morning run, a row a receptionist emptied on purpose.
// Both route through chooseTechnician, so the floor is never balanced by one
// rule in the morning and a different one at noon.
//
// Neither ever overwrites a technician already named on a booking. That single
// property is what makes the automation safe to re-run and impossible to lose a
// receptionist's decision to.
//
// The picking is pure enough to test; the telling is total and never throws, in
// the same spirit as lib/reviews/invite.ts — a mail server having a bad day must
// not block a customer standing at the desk.

import "server-only";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, lte, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, staff, staffTimeOff, stations, customers } from "@/lib/db/schema";
import { sendMail } from "@/lib/email";
import { recordAudit } from "@/lib/audit";
import { riyadhDateKey, riyadhDayRange } from "@/lib/time";
import { pick } from "@/lib/localized";
import { overlaps } from "@/lib/slots";
import { renderAssignmentEmail } from "./email";

/** Statuses that mean a technician is standing at a chair right now. */
const BUSY = ["checked_in", "in_progress"] as const;

/**
 * Who is not in today.
 *
 * The thing the old code could not know: pickTechnician's own note said
 * "available" could only mean "not mid-service", because nothing in the schema
 * recorded a day off. This is that missing piece, and both callers use it.
 *
 * Ranges are inclusive at both ends and stored as dates, so the comparison is a
 * string one against the Riyadh calendar day — no timezone arithmetic, and no
 * midnight-UTC row silently covering the wrong day.
 */
export async function offOn(day: Date = new Date()): Promise<Set<string>> {
  const key = riyadhDateKey(day);

  const rows = await db
    .select({ id: staffTimeOff.staffId })
    .from(staffTimeOff)
    .where(and(lte(staffTimeOff.startsOn, key), gte(staffTimeOff.endsOn, key)));

  return new Set(rows.map((r) => r.id));
}

/**
 * Who should take the customer who just walked in.
 *
 * "Available" means active, at this branch, in today (staff_time_off), and not
 * already holding a customer. Among those, the one with the fewest bookings
 * today, so the work spreads instead of always landing on whoever sorts first.
 *
 * Returns null when everyone is busy — check-in still succeeds, unassigned, and
 * the receptionist picks by hand. Refusing to check a customer in because the
 * floor is full would be worse than the problem it solves.
 *
 * Mostly a fallback now that assignDay() runs before opening: what reaches here
 * is a walk-in, a booking taken after the morning run, or one the front desk
 * emptied deliberately to hand back to the automation.
 */
export async function pickTechnician(branchId: string): Promise<string | null> {
  const { start, end } = riyadhDayRange();

  const [candidates, busy, todays, off] = await Promise.all([
    db
      .select({ id: staff.id })
      .from(staff)
      .where(
        and(eq(staff.active, true), eq(staff.role, "technician"), eq(staff.branchId, branchId)),
      )
      // Stable tie-break, so an even floor doesn't pick at random each time.
      .orderBy(asc(staff.id)),

    // Deliberately not bounded to today or to this branch: a technician holding
    // a customer is busy whenever and wherever that booking started. A booking
    // stuck `in_progress` from yesterday is a real thing, and quietly handing
    // its technician a second customer is how it stays stuck.
    db
      .select({ id: bookings.technicianId })
      .from(bookings)
      .where(and(inArray(bookings.status, [...BUSY]), isNotNull(bookings.technicianId))),

    db
      .select({ id: bookings.technicianId })
      .from(bookings)
      .where(
        and(
          eq(bookings.branchId, branchId),
          gte(bookings.startsAt, start),
          lt(bookings.startsAt, end),
          isNotNull(bookings.technicianId),
        ),
      ),

    offOn(),
  ]);

  const load = new Map<string, number>();
  for (const row of todays) {
    if (row.id) load.set(row.id, (load.get(row.id) ?? 0) + 1);
  }

  // Not in today and standing at a chair are different reasons for the same
  // answer, so they merge into the one set chooseTechnician subtracts.
  const unavailable = new Set([...off, ...(busy.map((b) => b.id).filter(Boolean) as string[])]);

  return chooseTechnician(
    candidates.map((c) => c.id),
    unavailable,
    load,
  );
}

/**
 * The decision itself, with the database taken out of it.
 *
 * Split from pickTechnician so scripts/check-roles.ts can exercise the rule —
 * skip the busy, prefer the least loaded, keep the order stable — without
 * needing a live Postgres to set up four technicians and a half-finished day.
 *
 * `candidates` is assumed already ordered; ties keep that order.
 */
export function chooseTechnician(
  candidates: string[],
  busyIds: Set<string>,
  load: Map<string, number>,
): string | null {
  const free = candidates.filter((id) => !busyIds.has(id));
  if (free.length === 0) return null;

  return free.reduce((best, id) => ((load.get(id) ?? 0) < (load.get(best) ?? 0) ? id : best));
}

/** The shape planAssignments needs: an id and the span it occupies. */
export type PlannableBooking = { id: string; startsAt: Date; endsAt: Date };

/**
 * Deal a whole day out across the technicians who are in.
 *
 * One pass in start order. For each booking, whoever is already holding an
 * overlapping slot is unavailable for it, and the rest goes to chooseTechnician
 * — the same "fewest bookings, stable order" rule check-in uses, so the two
 * entry points cannot drift apart.
 *
 * `initialLoad` is how bookings already assigned by hand pull their weight: the
 * spread tilts away from whoever the receptionist has already given work to,
 * instead of pretending the day starts empty.
 *
 * Pure on purpose — scripts/check-roles.ts exercises the whole rule without a
 * database, the same way it does chooseTechnician.
 *
 * ponytail: greedy first-fit, one pass, no backtracking. A later booking can
 * come back null where reshuffling earlier ones would have fitted it. A salon
 * runs tens of appointments a day against a handful of chairs, so the day it
 * matters is the day to reach for a real interval assignment — not before.
 */
export function planAssignments(
  bookings: PlannableBooking[],
  candidates: string[],
  initialLoad: Map<string, number> = new Map(),
  held: Map<string, { startsAt: Date; endsAt: Date }[]> = new Map(),
): Map<string, string | null> {
  // Both cloned, so a caller's maps are not mutated under it. The span arrays
  // inside need no copy: below they are replaced, never pushed into.
  const load = new Map(initialLoad);
  const busyWith = new Map(held);
  const out = new Map<string, string | null>();

  const inStartOrder = [...bookings].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  for (const b of inStartOrder) {
    const clashing = new Set(
      candidates.filter((id) =>
        (busyWith.get(id) ?? []).some((s) => overlaps(b.startsAt, b.endsAt, s.startsAt, s.endsAt)),
      ),
    );

    const chosen = chooseTechnician(candidates, clashing, load);
    out.set(b.id, chosen);

    if (chosen) {
      load.set(chosen, (load.get(chosen) ?? 0) + 1);
      busyWith.set(chosen, [
        ...(busyWith.get(chosen) ?? []),
        { startsAt: b.startsAt, endsAt: b.endsAt },
      ]);
    }
  }

  return out;
}

/**
 * Assign every unassigned booking of one branch's day.
 *
 * Called once a day by the dawn cron. Whatever it does not cover — a booking
 * taken after it ran, a walk-in — reaches a technician at check-in instead, or
 * from the desk by hand.
 *
 * **It only ever fills empty rows.** The WHERE clause carries `technician_id IS
 * NULL`, so a name a person put there — or one this job wrote and a person then
 * changed — is invisible to it. That is what makes it safe to re-run, safe to
 * double-fire, and safe to run late.
 *
 * Confirmed bookings only: a `pending` row is an unpaid hold that may never
 * become a booking, and taking a technician off the floor for one would be
 * inventing work.
 */
export async function assignDay(
  branchId: string,
  day: Date = new Date(),
): Promise<{ assigned: number; unassigned: number }> {
  const { start, end } = riyadhDayRange(day);
  const inTheDay = and(
    eq(bookings.branchId, branchId),
    gte(bookings.startsAt, start),
    lt(bookings.startsAt, end),
  );

  const [open, taken, technicians, off] = await Promise.all([
    db
      .select({ id: bookings.id, startsAt: bookings.startsAt, endsAt: bookings.endsAt })
      .from(bookings)
      .where(and(inTheDay, eq(bookings.status, "confirmed"), isNull(bookings.technicianId)))
      .orderBy(asc(bookings.startsAt)),

    // Already spoken for. Counted toward the spread, and their spans block the
    // technician who holds them — a manual 10am assignment must not be handed a
    // second customer at 10:15 by this job.
    //
    // Cancelled and no-show rows are not "spoken for": the technician named on
    // one is standing free. Without this filter a cancellation would hold her
    // hour hostage for the rest of the day — invisible while this only ran at
    // dawn, and wrong the moment it runs after a customer cancels.
    db
      .select({
        id: bookings.technicianId,
        startsAt: bookings.startsAt,
        endsAt: bookings.endsAt,
      })
      .from(bookings)
      .where(
        and(
          inTheDay,
          isNotNull(bookings.technicianId),
          notInArray(bookings.status, ["cancelled", "no_show"]),
        ),
      ),

    db
      .select({ id: staff.id })
      .from(staff)
      .where(
        and(eq(staff.active, true), eq(staff.role, "technician"), eq(staff.branchId, branchId)),
      )
      .orderBy(asc(staff.id)),

    offOn(day),
  ]);

  const candidates = technicians.map((t) => t.id).filter((id) => !off.has(id));
  if (open.length === 0 || candidates.length === 0) {
    return { assigned: 0, unassigned: open.length };
  }

  const load = new Map<string, number>();
  const held = new Map<string, { startsAt: Date; endsAt: Date }[]>();
  for (const row of taken) {
    if (!row.id) continue;
    load.set(row.id, (load.get(row.id) ?? 0) + 1);
    held.set(row.id, [...(held.get(row.id) ?? []), { startsAt: row.startsAt, endsAt: row.endsAt }]);
  }

  const plan = planAssignments(open, candidates, load, held);

  let assigned = 0;
  for (const [bookingId, technicianId] of plan) {
    if (!technicianId) continue;
    // `isNull` again, not just in the read: two runs firing at once must not
    // both win. Whoever writes second updates nothing.
    const done = await db
      .update(bookings)
      .set({ technicianId, updatedAt: new Date() })
      .where(and(eq(bookings.id, bookingId), isNull(bookings.technicianId)))
      .returning({ id: bookings.id });

    if (done.length === 0) continue;
    assigned++;

    // Audited like any other assignment. `recordAudit` already takes a null
    // actor id for mutations with no staff member behind them, so the trail
    // shows plainly which bookings a person assigned and which the job did.
    await recordAudit(
      { id: null, name: "Automatic assignment" },
      {
        action: "assign-technician",
        entity: "bookings",
        entityId: bookingId,
        diff: { technicianId: { from: null, to: technicianId } },
      },
    );
  }

  return { assigned, unassigned: open.length - assigned };
}

/**
 * Is this appointment on the day the salon is running right now?
 *
 * Split out for the same reason chooseTechnician is: it is the whole of the rule
 * deciding when live assignment happens, so scripts/check-roles.ts can walk it
 * across a Riyadh midnight without a database.
 */
export function isToday(day: Date, now: Date = new Date()): boolean {
  return riyadhDateKey(day) === riyadhDateKey(now);
}

/**
 * Deal today's floor again, because something on it just changed — a booking
 * paid for at noon, a cancellation, a reschedule, a technician sent home.
 *
 * One shared function rather than four narrow ones, because assignDay only ever
 * fills empty rows: it cannot take a customer off anyone, undo what a
 * receptionist chose, or do anything twice.
 *
 * **Today only.** An assignment made days ahead cannot see who will be on leave
 * by then, and filling the row is precisely what stops the dawn run looking at
 * it again — so an early guess would stick.
 *
 * Never throws. A booking without a technician is a line on the front desk's
 * screen, not a failed request.
 */
export async function assignIfToday(branchId: string, day: Date): Promise<void> {
  if (!isToday(day)) return;

  try {
    await assignDay(branchId);
  } catch (err) {
    console.error(`[assign] live run failed for branch ${branchId}`, err);
  }
}

/**
 * Tell a technician they have a customer.
 *
 * Total, like lib/reviews/invite.ts: every failure is swallowed and logged.
 * The customer is already checked in by the time this runs and the assignment is
 * already on the technician's screen — this mail is a nudge, not the mechanism.
 */
export async function notifyTechnician(bookingId: string): Promise<void> {
  try {
    const [row] = await db
      .select({
        ticketNo: bookings.ticketNo,
        startsAt: bookings.startsAt,
        serviceName: bookings.serviceName,
        stationLabel: stations.label,
        customerName: customers.name,
        techName: staff.name,
        techEmail: staff.email,
      })
      .from(bookings)
      .leftJoin(stations, eq(stations.id, bookings.stationId))
      .leftJoin(customers, eq(customers.id, bookings.customerId))
      .leftJoin(staff, eq(staff.id, bookings.technicianId))
      .where(eq(bookings.id, bookingId))
      .limit(1);

    if (!row?.techEmail) return; // unassigned, or a technician with no address

    const mail = renderAssignmentEmail({
      ticketNo: row.ticketNo,
      techName: row.techName,
      // First name only — it is all the technician needs to greet her by.
      customerName: row.customerName?.trim().split(/\s+/)[0] ?? null,
      serviceName: row.serviceName ? pick(row.serviceName, "ar") : null,
      stationLabel: row.stationLabel,
      startsAt: row.startsAt,
    });

    const sent = await sendMail({
      to: row.techEmail,
      toName: row.techName,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      tags: ["technician-assignment"],
    });

    if (!sent.ok && sent.reason !== "not-configured") {
      console.error(`[assign] could not mail technician for ${bookingId}: ${sent.reason}`);
    }
  } catch (err) {
    console.error(`[assign] notify failed for ${bookingId}`, err);
  }
}
