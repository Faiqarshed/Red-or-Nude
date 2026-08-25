// Handing a checked-in customer to a technician (brief §3.1, §3.2).
//
// Two jobs, kept apart on purpose: picking who gets the work, and telling them.
// The pick is pure enough to test; the telling is total and never throws, in the
// same spirit as lib/reviews/invite.ts — a mail server having a bad day must not
// block a customer standing at the desk.

import "server-only";
import { and, asc, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, staff, stations, customers } from "@/lib/db/schema";
import { sendMail } from "@/lib/email";
import { riyadhDayRange } from "@/lib/time";
import { pick } from "@/lib/localized";
import { renderAssignmentEmail } from "./email";

/** Statuses that mean a technician is standing at a chair right now. */
const BUSY = ["checked_in", "in_progress"] as const;

/**
 * Who should take the customer who just walked in.
 *
 * "Available" means active, at this branch, and not already holding a customer.
 * Among those, the one with the fewest bookings today, so the work spreads
 * instead of always landing on whoever sorts first.
 *
 * Returns null when everyone is busy — check-in still succeeds, unassigned, and
 * the receptionist picks by hand. Refusing to check a customer in because the
 * floor is full would be worse than the problem it solves.
 *
 * ponytail: there is no roster or shift table in the schema, so this cannot know
 * who is rostered off today — only who is mid-service. Add a shifts table if the
 * salon ever needs "available" to mean more than that.
 */
export async function pickTechnician(branchId: string): Promise<string | null> {
  const { start, end } = riyadhDayRange();

  const [candidates, busy, todays] = await Promise.all([
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
  ]);

  const load = new Map<string, number>();
  for (const row of todays) {
    if (row.id) load.set(row.id, (load.get(row.id) ?? 0) + 1);
  }

  return chooseTechnician(
    candidates.map((c) => c.id),
    new Set(busy.map((b) => b.id).filter(Boolean) as string[]),
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
