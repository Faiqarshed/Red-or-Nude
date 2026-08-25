"use server";

// The technician's two buttons (brief §3.2).
//
// `bookings.own` finally gets read here — it has been in the capability matrix
// since P0 with nothing checking it. Note that the capability alone is not the
// authorisation: it says "technicians may act on their own bookings", and only
// the technician_id comparison proves this is one of theirs. Both, every time.

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings } from "@/lib/db/schema";
import { requireCan } from "@/lib/auth/guard";
import { recordAudit } from "@/lib/audit";

export type Result = { ok: true } | { ok: false; error: string };

function revalidate() {
  revalidatePath("/admin");
  revalidatePath("/admin/bookings");
}

/**
 * "I have confirmed the ticket number with her and we are starting."
 *
 * The update is guarded on ownership *and* on the status it expects, so the row
 * count settles every race: a receptionist cancelling at the same moment, or a
 * double-tap on a phone, changes nothing the second time.
 */
export async function startService(id: string): Promise<Result> {
  const user = await requireCan("bookings.own");

  const [row] = await db
    .update(bookings)
    .set({ status: "in_progress", startedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(bookings.id, id),
        eq(bookings.technicianId, user.id),
        eq(bookings.status, "checked_in"),
      ),
    )
    .returning({ id: bookings.id });

  if (!row) return { ok: false, error: "not-yours-or-not-waiting" };

  await recordAudit(user, {
    action: "start-service",
    entity: "bookings",
    entityId: id,
    diff: { status: { from: "checked_in", to: "in_progress" } },
  });

  revalidate();
  return { ok: true };
}

/**
 * "I am done." Not the same as the ticket being closed — the receptionist does
 * that (brief §3.1), and the status only reaches `completed` then.
 *
 * Keeping them apart is what stops a slow front desk landing on the technician's
 * KPI: her number ends here, whenever reception gets round to the paperwork.
 *
 * `finished_at is null` in the guard makes it idempotent — pressing twice keeps
 * the first time, which is the honest one.
 */
export async function finishService(id: string): Promise<Result> {
  const user = await requireCan("bookings.own");

  const [row] = await db
    .update(bookings)
    .set({ finishedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(bookings.id, id),
        eq(bookings.technicianId, user.id),
        eq(bookings.status, "in_progress"),
        isNull(bookings.finishedAt),
      ),
    )
    .returning({ id: bookings.id });

  if (!row) return { ok: false, error: "not-yours-or-not-running" };

  await recordAudit(user, {
    action: "finish-service",
    entity: "bookings",
    entityId: id,
    diff: { finishedAt: { from: null, to: new Date().toISOString() } },
  });

  revalidate();
  return { ok: true };
}
