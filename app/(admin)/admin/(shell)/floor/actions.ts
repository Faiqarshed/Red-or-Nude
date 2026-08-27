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
import { riyadhDateKey } from "@/lib/time";

export type Result = { ok: true } | { ok: false; error: string };

/** Both actions answer the same question first: is she mine to move? */
async function myTechnician(
  actor: SessionStaff,
  staffId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [target] = await db.select().from(staff).where(eq(staff.id, staffId)).limit(1);
  if (!target || target.role !== "technician") return { ok: false, error: "not-found" };
  // Her own branch only. The desk reshuffles its own floor, never another's.
  if (actor.branchId && target.branchId !== actor.branchId) {
    return { ok: false, error: "other-branch" };
  }
  return { ok: true };
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
 * Her existing bookings are deliberately left on her. Silently stripping
 * customers off a live floor would lose the receptionist's place — she can see
 * them listed on this screen and move them one at a time, which is the whole
 * point of the screen.
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

  // Pressed twice, or already on leave from Staff — either way she is out, and
  // a second row would only need deleting twice to bring her back.
  if (existing) return { ok: true };

  const [row] = await db
    .insert(staffTimeOff)
    .values({ staffId, startsOn: day, endsOn: day, reason: "sent home" })
    .returning({ id: staffTimeOff.id });

  await recordAudit(actor, {
    action: "send-home",
    entity: "staff_time_off",
    entityId: row.id,
    diff: { staffId: { from: null, to: staffId }, day: { from: null, to: day } },
  });

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
