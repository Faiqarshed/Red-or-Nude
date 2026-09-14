"use server";

// Sending a technician home, and bringing her back.
//
// Gated on bookings.checkin rather than staff.manage on purpose: the person who
// knows someone has gone home sick is the receptionist standing next to her, and
// making her phone a manager means the assignment run keeps handing customers to
// somebody who left. This is a floor operation, not an HR one.
//
// That is also why it is bounded to **today**. A day off written here covers this
// day and no other; holidays and planned leave stay under Staff, where the
// capability that governs staff records applies.

import { revalidatePath } from "next/cache";
import { and, eq, gte, inArray, lt, lte } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { bookings, staff, staffTimeOff } from "@/lib/db/schema";
import { requireCan, type SessionStaff } from "@/lib/auth/guard";
import { recordAudit } from "@/lib/audit";
import { offOn, releaseToday } from "@/lib/assign";
import { riyadhDateKey, riyadhDayRange } from "@/lib/time";

/** `released` is how many customers just lost their technician — see sendHome. */
export type Result = { ok: true; released?: number } | { ok: false; error: string };

/** Both actions answer the same question first: is she mine to move? */
async function myTechnician(
  actor: SessionStaff,
  staffId: string,
): Promise<{ ok: true; branchId: string | null } | { ok: false; error: string }> {
  const [target] = await db.select().from(staff).where(eq(staff.id, staffId)).limit(1);
  if (!target || target.role !== "technician") return { ok: false, error: "not-found" };
  // Her own branch only. The desk reshuffles its own floor, never another's.
  if (actor.branchId && target.branchId !== actor.branchId) {
    return { ok: false, error: "other-branch" };
  }
  // Her branch comes back with the answer: sending her home re-deals that floor,
  // and looking the same row up twice for it would be silly.
  return { ok: true, branchId: target.branchId };
}

/** The desk shows through three routes; a floor change touches all of them. */
function revalidate() {
  revalidatePath("/admin/floor");
  revalidatePath("/admin");
  revalidatePath("/admin/front-desk");
}

const movesSchema = z
  .array(z.object({ bookingId: z.string().uuid(), technicianId: z.string().uuid() }))
  .max(200);

/**
 * She has gone home — and every customer she was still waiting on has somebody.
 *
 * **One call, after the desk has placed them all.** This used to take her
 * customers off her the moment Send home was pressed and then open a popup asking
 * where they should go. There was no way back from that popup: close it and the
 * bookings were already sitting unassigned behind it. Now the screen asks first,
 * and nothing changes until it sends the whole answer here.
 *
 * Refused as `unplaced` if a waiting booking has no move — re-read here, not
 * trusted from the screen, because one may have been assigned to her since the
 * popup opened. Refused as `bad-target` for a move to herself, to somebody off
 * today, or to anyone who is not a technician at her branch.
 *
 * Dealing them automatically was tried and dropped: four customers at one hour
 * with two technicians left cannot all be placed, and the run silently returned
 * some unassigned while looking like it had done the job. Who waits and who is
 * rescheduled is the desk's call.
 *
 * Anything she has already started stays hers, because the customer is sitting
 * in front of her.
 */
export async function sendHome(
  staffId: string,
  moves: { bookingId: string; technicianId: string }[] = [],
): Promise<Result> {
  const actor = await requireCan("bookings.checkin");

  const mine = await myTechnician(actor, staffId);
  if (!mine.ok) return mine;

  const parsed = movesSchema.safeParse(moves);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const to = new Map(parsed.data.map((m) => [m.bookingId, m.technicianId]));

  // What she is still owed today: everything confirmed she has not started.
  // `checked_in` and `in_progress` stay hers — see releaseToday for why the
  // rule is the status and not the clock.
  const { start, end } = riyadhDayRange();
  const waiting = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.technicianId, staffId),
        eq(bookings.status, "confirmed"),
        gte(bookings.startsAt, start),
        lt(bookings.startsAt, end),
      ),
    );
  if (waiting.some((w) => !to.has(w.id))) return { ok: false, error: "unplaced" };

  const targets = [...new Set(waiting.map((w) => to.get(w.id)!))];
  if (targets.length) {
    const [valid, off] = await Promise.all([
      db
        .select({ id: staff.id })
        .from(staff)
        .where(
          and(
            inArray(staff.id, targets),
            eq(staff.role, "technician"),
            eq(staff.active, true),
            mine.branchId ? eq(staff.branchId, mine.branchId) : undefined,
          ),
        ),
      offOn(),
    ]);
    if (targets.includes(staffId) || valid.length !== targets.length || targets.some((id) => off.has(id))) {
      return { ok: false, error: "bad-target" };
    }
  }

  // Each only while it is still hers and still waiting, so a booking somebody
  // checked in or moved a second ago is left as that person made it.
  for (const w of waiting) {
    await db
      .update(bookings)
      .set({ technicianId: to.get(w.id)!, updatedAt: new Date() })
      .where(
        and(eq(bookings.id, w.id), eq(bookings.technicianId, staffId), eq(bookings.status, "confirmed")),
      );
  }

  const day = riyadhDateKey();
  const [existing] = await db
    .select({ id: staffTimeOff.id })
    .from(staffTimeOff)
    .where(
      and(
        eq(staffTimeOff.staffId, staffId),
        lte(staffTimeOff.startsOn, day),
        gte(staffTimeOff.endsOn, day),
      ),
    )
    .limit(1);

  // Normally nothing: every waiting booking was just moved. Only a booking handed
  // to her in the moment between the read above and now is left, and it goes to
  // the unassigned list at the top of the floor rather than staying on her.
  const released = await releaseToday(staffId);

  // Pressed twice, or already on leave from Staff — either way she is out, and
  // a second row would only need deleting twice to bring her back. The release
  // above still ran, so a second press cannot leave customers stranded on her.
  const timeOffId =
    existing?.id ??
    (
      await db
        .insert(staffTimeOff)
        .values({ staffId, startsOn: day, endsOn: day, reason: "sent home" })
        .returning({ id: staffTimeOff.id })
    )[0].id;

  // Audited whenever the floor actually moved — not only when this press was
  // the one that wrote the time-off row.
  //
  // A technician already covered by leave from Staff still has her waiting
  // customers taken off her here, and nesting the audit inside the insert meant
  // five appointments could change hands leaving nothing behind to say who did
  // it or why. The question the trail has to answer is "who moved these?", and
  // that is the release, not the row.
  //
  // Silent only when nothing happened: pressed twice, second press, no rows
  // left to release. There is no change to record.
  if (waiting.length || released.length || !existing) {
    await recordAudit(actor, {
      action: "send-home",
      entity: "staff_time_off",
      entityId: timeOffId,
      diff: {
        staffId: { from: null, to: staffId },
        day: { from: null, to: day },
        // Who took which customer — the question the trail has to answer.
        moved: { from: null, to: waiting.map((w) => ({ bookingId: w.id, technicianId: to.get(w.id) })) },
        released: { from: null, to: released.length },
      },
    });
  }

  revalidate();
  return { ok: true, released: released.length };
}

/**
 * She is back after all.
 *
 * Clears **today's** rows only, so a mistaken press is undoable without handing
 * the desk the ability to cancel someone's booked holiday.
 */
export async function bringBack(staffId: string): Promise<Result> {
  const actor = await requireCan("bookings.checkin");

  const mine = await myTechnician(actor, staffId);
  if (!mine.ok) return mine;

  const day = riyadhDateKey();
  const gone = await db
    .delete(staffTimeOff)
    .where(
      and(
        eq(staffTimeOff.staffId, staffId),
        // Only a row that is exactly today. A range spanning today is somebody's
        // holiday, and the front desk does not get to end one.
        eq(staffTimeOff.startsOn, day),
        eq(staffTimeOff.endsOn, day),
      ),
    )
    .returning({ id: staffTimeOff.id });

  if (gone.length === 0) return { ok: false, error: "on-leave" };

  await recordAudit(actor, {
    action: "bring-back",
    entity: "staff_time_off",
    entityId: gone[0]!.id,
    diff: { staffId: { from: staffId, to: null }, day: { from: day, to: null } },
  });

  revalidate();
  return { ok: true };
}
