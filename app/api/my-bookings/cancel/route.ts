// Cancel a booking from the customer's own history (brief §2.6).
//
// Fully automated — no receptionist in the loop — and the freed chair becomes
// bookable the instant this commits. That takes no work: `cancelled` is excluded
// from the `bookings_station_slot_unique` index, from `reserveStations`, and
// from the availability engine's conflict scan, so cancelling *is* releasing.
//
// Auth is not the booking reference alone. A reference is forwardable and stays
// valid in an inbox forever, so on its own it proves only that you know which
// booking you mean — enough to read it, not enough to end it. This wants a
// session that owns the row, or a code sent to the booking's own address; see
// lib/booking-auth.ts. The throttle below and the audit row remain, but they
// are no longer the only guards.

import { NextResponse } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { bookings } from "@/lib/db/schema";
import { cancelDeadline, cancelRefusal } from "@/lib/cancellation";
import { getSettings } from "@/lib/settings";
import { clientIp, throttled } from "@/lib/throttle";
import { refundBookings } from "@/lib/payments/refund";
import { returnPackCredits } from "@/lib/packs";
import { recordAudit } from "@/lib/audit";
import { notifyCustomer } from "@/lib/notify/customer";
import { refuseBookingAction } from "@/lib/booking-auth";
import { assignIfToday } from "@/lib/assign";
import { utcToLocalDate } from "@/lib/availability";
import { OTP_LENGTH } from "@/lib/otp";

export const dynamic = "force-dynamic";

const body = z.object({
  code: z.string().trim().min(4).max(20),
  // Absent on the first attempt: a guest is expected to be turned away once
  // with `otp-required`, which is the screen's cue to ask for a code.
  // A regex literal, not a template string: `\d` inside backticks is just "d",
  // which silently makes the pattern match six letter-d's and nothing else.
  otp: z.string().trim().length(OTP_LENGTH).regex(/^\d+$/).optional(),
});

export async function POST(request: Request) {
  // Tighter than the read endpoint: this one moves money and frees chairs, so
  // there is no legitimate reason to call it five times a minute.
  if (throttled(`cancel:${clientIp(request)}`, { max: 5 })) {
    return NextResponse.json({ error: "too-many" }, { status: 429 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const parsed = body.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const code = parsed.data.code.toUpperCase();

  const [anchor] = await db.select().from(bookings).where(eq(bookings.code, code)).limit(1);
  // No pretence that this hides whether the reference exists — POST
  // /api/my-bookings answers that openly and by design. What is guarded here is
  // the action, not the existence of the booking.
  if (!anchor) return NextResponse.json({ error: "wrong" }, { status: 401 });

  const denied = await refuseBookingAction(anchor, parsed.data.otp);
  if (denied) {
    return NextResponse.json({ error: denied.error }, { status: denied.status });
  }

  const { cancel_cutoff_hours: cutoff } = await getSettings(["cancel_cutoff_hours"]);

  // A group cancels as a unit. It is one combined bill (§2.4) at a discount that
  // only exists because two people booked together, so releasing half of it
  // would leave the other guest holding a pair price for a solo appointment.
  const members = anchor.groupId
    ? await db
        .select()
        .from(bookings)
        .where(eq(bookings.groupId, anchor.groupId))
        .orderBy(asc(bookings.createdAt), asc(bookings.id))
    : [anchor];

  // Which means it has to be *cancellable* as a unit too, and that is judged on
  // every guest rather than on the one whose reference was quoted.
  //
  // Asking only the anchor split parties down the middle. One friend arrives and
  // the desk checks her in; the other cancels from her phone; the anchor is
  // still `confirmed` so the request is allowed, and the update below silently
  // passes over the guest who is already in the chair. Her friend is released,
  // she is not, and she is left alone holding a price that existed because two
  // of them booked together — the exact outcome the paragraph above forbids.
  //
  // So whoever is furthest along decides for all of them: a party with someone
  // already in a chair is the branch's to sort out, not a self-service button's.
  const refused = members.map((m) => cancelRefusal(m, cutoff)).find(Boolean);
  if (refused) {
    return NextResponse.json(
      {
        error: refused,
        // The customer is being refused; telling them the deadline they missed
        // is more use than telling them "no".
        cancelBy: cancelDeadline(anchor, cutoff).toISOString(),
        cutoffHours: cutoff,
      },
      { status: 409 },
    );
  }

  // One statement, so it needs no transaction to be atomic. Guarded on status as
  // well as id: two taps on a slow connection must not produce two refunds — the
  // second matches nothing and returns nothing.
  const cancelled = (
    await db
      .update(bookings)
      .set({ status: "cancelled", cancelReason: "customer", updatedAt: new Date() })
      .where(
        and(
          inArray(
            bookings.id,
            members.map((m) => m.id),
          ),
          inArray(bookings.status, ["pending", "confirmed"]),
        ),
      )
      .returning({ id: bookings.id })
  ).map((r) => r.id);

  if (cancelled.length === 0) {
    return NextResponse.json({ error: "already-cancelled" }, { status: 409 });
  }

  // Money comes back after the chair is released, never before: a gateway that
  // is having a bad day must not be able to keep a customer's appointment alive.
  // refundBookings never throws — a failure is logged for the admin to settle.
  const refund = await refundBookings(cancelled, "customer-cancelled");

  // A pack credit comes back exactly where money does, and only where money
  // does. Inside the window it is returned; cancel later and it is spent, the
  // same way the fee is kept — the symmetry is the rule, and putting this call
  // beside the refund is what keeps the two from drifting apart.
  //
  // Nothing here can fail the cancellation: the chair is already released, and a
  // credit that did not come back is a support ticket, not a reason to leave an
  // appointment standing.
  let creditsBack = 0;
  try {
    creditsBack = await returnPackCredits(cancelled, "customer-cancelled");
  } catch (err) {
    console.error("[cancel] could not return pack credits", err);
  }

  await recordAudit(
    { id: null, name: "customer" },
    {
      action: "cancel",
      entity: "bookings",
      entityId: anchor.id,
      diff: {
        status: { from: anchor.status, to: "cancelled" },
        refundedHalalas: { from: null, to: refund.ok ? refund.amountHalalas : null },
        packCreditsReturned: { from: null, to: creditsBack || null },
      },
    },
  );

  await notifyCustomer(anchor.customerId, "booking-cancelled", { count: cancelled.length });

  // The chair came free and so did whoever was holding this hour. Anything left
  // unassigned today may now be staffable, so run the day again — it only fills
  // empty rows, so nobody loses a customer over someone else's cancellation.
  //
  // Once per floor the party sat on, not once for the anchor's. A group may be
  // spread across branches and hours now, and the chair freed at the far one is
  // exactly the one no other pass would come back for.
  const floors = new Map<string, (typeof members)[number]>();
  for (const m of members) floors.set(`${m.branchId}:${utcToLocalDate(m.startsAt)}`, m);
  for (const m of floors.values()) await assignIfToday(m.branchId, m.startsAt);

  return NextResponse.json({
    ok: true,
    cancelled: cancelled.length,
    // `false` here is not a failed cancellation — the booking is gone either
    // way. It means the money needs a human, and the screen says so.
    refunded: refund.ok,
  });
}
