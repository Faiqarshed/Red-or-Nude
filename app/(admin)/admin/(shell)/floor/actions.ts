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
import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { staff, staffTimeOff } from "@/lib/db/schema";
import { requireCan, type SessionStaff } from "@/lib/auth/guard";
import { recordAudit } from "@/lib/audit";
import { assignIfToday, releaseToday } from "@/lib/assign";
import { riyadhDateKey } from "@/lib/time";

export type Result = { ok: true } | { ok: false; error: string };

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

/**
 * She has gone home.
 *
 * Writes a one-day time-off row, which is all it takes for the morning run and
 * the check-in picker to stop choosing her, and for both dropdowns to grey her
 * out.
 *
 * Then her waiting customers are handed straight to whoever is still in. This
 * used to leave them on her on the grounds that stripping a live floor would
 * lose the receptionist's place — but that was true only while there was nothing
 * to hand them to. Now there is: the rows are emptied and re-dealt in the same
 * breath, so the desk sees new names rather than an empty column, and finds out
 * now instead of at the appointment time. Anything she has already started stays
 * hers, because the customer is sitting in front of her.
 */
export async function sendHome(staffId: string): Promise<Result> {
  const actor = await requireCan("bookings.checkin");

  const mine = await myTechnician(actor, staffId);
  if (!mine.ok) return mine;

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

  // What she is still owed today: everything confirmed she has not started.
  // `checked_in` and `in_progress` stay hers on purpose — that customer is
  // already with her, and moving them would be a lie on a screen. See
  // releaseToday for why the rule is the status and not the clock.
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
  if (released.length || !existing) {
    await recordAudit(actor, {
      action: "send-home",
      entity: "staff_time_off",
      entityId: timeOffId,
      diff: {
        staffId: { from: null, to: staffId },
        day: { from: null, to: day },
        released: { from: null, to: released.length },
      },
    });
  }

  // Ordered after the time-off row on purpose: this run reads it, and would hand
  // her own customers straight back if it went first.
  if (mine.branchId) await assignIfToday(mine.branchId, new Date());

  revalidate();
  return { ok: true };
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
