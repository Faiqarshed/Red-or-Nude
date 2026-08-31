"use server";

// The front desk's three moves: find a ticket, check her in, close the ticket.
//
// Status writes go through setBookingStatus in ../bookings/actions.ts rather
// than being repeated here — that function stamps the timings, assigns the
// technician, sends her mail and fires the review invitation. One write path for
// the status means those side effects can't be forgotten by a second caller.

import { and, eq, gte, lt, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, type Localized } from "@/lib/db/schema";
import { requireCan } from "@/lib/auth/guard";
import { recordAudit } from "@/lib/audit";
import { riyadhDayRange } from "@/lib/time";
import { getSettings } from "@/lib/settings";
import { setBookingStatus } from "../bookings/actions";

export type Result = { ok: true } | { ok: false; error: string };

export type TicketMatch = {
  id: string;
  ticketNo: string | null;
  startsAt: string;
  status: string;
  serviceName: Localized | null;
  customerName: string | null;
  technicianId: string | null;
  /** The earliest moment this booking may be checked in — see checkin_early_min. */
  checkInOpensAt: string;
};

export type LookupResult =
  | { ok: true; booking: TicketMatch }
  | { ok: false; error: "not-found" };

/**
 * Find today's booking at this branch, by ticket number **or** booking code.
 *
 * Both, because the customer decides which one she reads out. `A12` is what the
 * salon calls across the floor; `RON-4F2K` is what her confirmation email leads
 * with. A desk that accepts only one of them fails half the time, for a reason
 * the receptionist cannot see.
 *
 * Scoped to the day and the branch because that is the only scope in which a
 * ticket number is unique — `ticket_no` restarts every morning at every branch.
 * A wider search would happily return last Tuesday's A12. The booking code is
 * globally unique and does not need the bound, but shares it so that one query
 * answers both and "not today" stays one honest message.
 */
export async function findTicket(branchId: string, ticketNo: string): Promise<LookupResult> {
  await requireCan("bookings.checkin");

  const code = ticketNo.trim().toUpperCase();
  if (!code) return { ok: false, error: "not-found" };

  const { start, end } = riyadhDayRange();

  const [row] = await db
    .select({
      id: bookings.id,
      ticketNo: bookings.ticketNo,
      startsAt: bookings.startsAt,
      status: bookings.status,
      serviceName: bookings.serviceName,
      customerName: customers.name,
      technicianId: bookings.technicianId,
    })
    .from(bookings)
    .leftJoin(customers, eq(customers.id, bookings.customerId))
    .where(
      and(
        eq(bookings.branchId, branchId),
        or(eq(bookings.ticketNo, code), eq(bookings.code, code)),
        gte(bookings.startsAt, start),
        lt(bookings.startsAt, end),
      ),
    )
    .limit(1);

  if (!row) return { ok: false, error: "not-found" };

  // Sent back so the desk can say *when* she can be checked in, rather than only
  // that she can't. The server re-checks on the way in; this is for the message.
  const { checkin_early_min: earlyMin } = await getSettings(["checkin_early_min"]);

  return {
    ok: true,
    booking: {
      ...row,
      startsAt: row.startsAt.toISOString(),
      checkInOpensAt: new Date(row.startsAt.getTime() - earlyMin * 60_000).toISOString(),
    },
  };
}

/**
 * She's here. Start her clock and hand her to a technician.
 *
 * `technicianId` is the receptionist overriding the automatic pick. Written
 * before the status changes, because setBookingStatus only auto-assigns when the
 * booking doesn't already name someone — so writing it first *is* the override.
 */
export async function checkInTicket(id: string, technicianId?: string | null): Promise<Result> {
  await requireCan("bookings.checkin");

  const [before] = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
  if (!before) return { ok: false, error: "not-found" };
  if (before.status === "checked_in" || before.status === "in_progress") {
    return { ok: false, error: "already-checked-in" };
  }
  if (before.status !== "confirmed") return { ok: false, error: "not-checkable" };

  // The "not before her slot" rule is not repeated here. It moved to
  // setBookingStatus, which every path into `checked_in` goes through — a
  // disabled button is a courtesy and a check in one of two callers is not much
  // better. `too-early` still comes back from the call below, unchanged.
  if (technicianId) await assignTechnician(id, technicianId);

  return setBookingStatus(id, "checked_in");
}

/**
 * "End" (brief §3.1) — the receptionist closing the ticket after the technician
 * has reported done. This is what sends the rating invitation, via
 * setBookingStatus's existing transition into `completed`.
 */
export async function closeTicket(id: string): Promise<Result> {
  await requireCan("bookings.checkin");
  return setBookingStatus(id, "completed");
}

/**
 * Reassign without checking anyone in — the receptionist swapping a technician
 * on a booking already in progress, or covering for someone who went home sick
 * (brief §3.3).
 *
 * Only ever *to* somebody. An empty technician is how the floor says "this
 * booking arrived after the morning run", so clearing one by hand would forge
 * that signal — the screen offers no way to, and neither does this.
 *
 * And only while there is still work to move:
 *
 * - Once the technician has pressed Finish the row records who did the service,
 *   and /admin/performance reads her timings straight off it, so a reassignment
 *   after the fact would credit the minutes to someone who was never at the
 *   chair.
 * - A `no_show` has nothing to hand anybody. The customer never came, the chair
 *   has already been released by sweepNoShows, and what she needs is a new
 *   appointment — naming a technician on it would only put a fictional booking
 *   on that technician's day.
 *
 * The screen greys the dropdown out at the same moments, but that is the
 * courtesy; this is the rule.
 */
export async function assignTechnician(id: string, technicianId: string): Promise<Result> {
  const actor = await requireCan("bookings.checkin");

  const [before] = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
  if (!before) return { ok: false, error: "not-found" };
  if (before.status === "no_show") return { ok: false, error: "no-show" };
  if (before.finishedAt || before.status === "completed" || before.status === "cancelled") {
    return { ok: false, error: "already-finished" };
  }

  await db
    .update(bookings)
    .set({ technicianId, updatedAt: new Date() })
    .where(eq(bookings.id, id));

  await recordAudit(actor, {
    action: "assign-technician",
    entity: "bookings",
    entityId: id,
    diff: { technicianId: { from: before.technicianId, to: technicianId } },
  });

  return { ok: true };
}

