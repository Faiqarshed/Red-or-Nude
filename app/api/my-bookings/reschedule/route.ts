// Move a booking from the customer's own history (brief §2.6).
//
// Same window as cancellation and the same reasoning about auth — see
// ../cancel/route.ts, which explains both. What differs is the money: nothing
// moves. Same service, same duration, same total, so there is no charge, no
// refund and no new ticket number; only the time and the chair change.
//
// The chair is picked by the engine rather than kept. A customer moving to
// Thursday has no stake in which table they had on Tuesday, and insisting on
// the old one would refuse slots that are genuinely free.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { bookings } from "@/lib/db/schema";
import { cancelDeadline, cancelRefusal } from "@/lib/cancellation";
import { rescheduleBooking } from "@/lib/bookings";
import { getSettings } from "@/lib/settings";
import { clientIp, throttled } from "@/lib/throttle";
import { recordAudit } from "@/lib/audit";
import { notifyCustomer } from "@/lib/notify/customer";

export const dynamic = "force-dynamic";

const body = z.object({
  code: z.string().trim().min(4).max(20),
  startsAt: z.string().datetime(),
});

export async function POST(request: Request) {
  if (throttled(`reschedule:${clientIp(request)}`, { max: 5 })) {
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
  const startsAt = new Date(parsed.data.startsAt);

  const [before] = await db.select().from(bookings).where(eq(bookings.code, code)).limit(1);
  if (!before) return NextResponse.json({ error: "not-found" }, { status: 404 });

  const { cancel_cutoff_hours: cutoff, booking_lead_time_min: leadMin } = await getSettings([
    "cancel_cutoff_hours",
    "booking_lead_time_min",
  ]);

  // The window is checked against the appointment they *have*, not the one they
  // want. Moving is a privilege of a booking still under the customer's control;
  // an appointment two hours away is the salon's to change, not theirs.
  const refusal = cancelRefusal(before, cutoff);
  if (refusal) {
    return NextResponse.json(
      {
        error: refusal,
        cancelBy: cancelDeadline(before, cutoff).toISOString(),
        cutoffHours: cutoff,
      },
      { status: 409 },
    );
  }

  // And the destination has to be a slot they could have booked from scratch.
  // The picker already hides earlier ones; this is what stops a hand-crafted
  // request landing an appointment ten minutes from now, or last Tuesday.
  if (startsAt.getTime() < Date.now() + leadMin * 60_000) {
    return NextResponse.json({ error: "too-soon", leadTimeMin: leadMin }, { status: 409 });
  }

  const moved = await rescheduleBooking({ id: before.id, startsAt });
  if (!moved.ok) {
    const status = moved.error === "not-found" ? 404 : moved.error === "slot-taken" ? 409 : 500;
    return NextResponse.json({ error: moved.error }, { status });
  }

  await recordAudit(
    { id: null, name: "customer" },
    {
      action: "reschedule",
      entity: "bookings",
      entityId: before.id,
      diff: {
        startsAt: { from: before.startsAt.toISOString(), to: startsAt.toISOString() },
      },
    },
  );

  await notifyCustomer(before.customerId, "booking-rescheduled", {
    startsAt: startsAt.toISOString(),
  });

  // The new chair is deliberately not reported. The customer is told their time,
  // and the table is on the ticket they already hold — resolving the label cost
  // a query for something nothing displayed.
  return NextResponse.json({ ok: true, startsAt: startsAt.toISOString() });
}
