// Cancel a booking from the customer's own history (brief §2.6).
//
// Fully automated — no receptionist in the loop — and the freed chair becomes
// bookable the instant this commits. That takes no work: `cancelled` is excluded
// from the `bookings_station_slot_unique` index, from `reserveStations`, and
// from the availability engine's conflict scan, so cancelling *is* releasing.
//
// Auth is the booking reference alone, deliberately. It arrives in the
// customer's own inbox, and a refund always returns to the card that paid, so
// the worst a leaked reference buys is a nuisance cancellation — not money. The
// guards are the throttle below and an audit row, not an OTP round-trip on every
// cancel. If that ever stops being true, wrapping this in `verifyOtp` the way
// ../refill/route.ts does is a few lines; lib/otp.ts is already built.

import { NextResponse } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { bookings } from "@/lib/db/schema";
import { cancelDeadline, cancelRefusal } from "@/lib/cancellation";
import { getSettings } from "@/lib/settings";
import { clientIp, throttled } from "@/lib/throttle";
import { refundBookings } from "@/lib/payments/refund";
import { recordAudit } from "@/lib/audit";
import { notifyCustomer } from "@/lib/notify/customer";

export const dynamic = "force-dynamic";

const body = z.object({ code: z.string().trim().min(4).max(20) });

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
  // Same opaque "no" the lookup endpoint gives, so a caller walking the code
  // space learns nothing from the difference.
  if (!anchor) return NextResponse.json({ error: "not-found" }, { status: 404 });

  const { cancel_cutoff_hours: cutoff } = await getSettings(["cancel_cutoff_hours"]);
  const refusal = cancelRefusal(anchor, cutoff);
  if (refusal) {
    return NextResponse.json(
      {
        error: refusal,
        // The customer is being refused; telling them the deadline they missed
        // is more use than telling them "no".
        cancelBy: cancelDeadline(anchor, cutoff).toISOString(),
        cutoffHours: cutoff,
      },
      { status: 409 },
    );
  }

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

  await recordAudit(
    { id: null, name: "customer" },
    {
      action: "cancel",
      entity: "bookings",
      entityId: anchor.id,
      diff: {
        status: { from: anchor.status, to: "cancelled" },
        refundedHalalas: { from: null, to: refund.ok ? refund.amountHalalas : null },
      },
    },
  );

  await notifyCustomer(anchor.customerId, "booking-cancelled", { count: cancelled.length });

  return NextResponse.json({
    ok: true,
    cancelled: cancelled.length,
    // `false` here is not a failed cancellation — the booking is gone either
    // way. It means the money needs a human, and the screen says so.
    refunded: refund.ok,
  });
}
