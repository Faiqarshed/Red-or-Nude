// Return the booking's refill details to someone who has proved it is theirs.
//
// This is the only endpoint that reveals anything beyond a booking's own
// summary, which is why the reference alone has never been enough for it. It
// now takes the same credential as cancelling and rescheduling — a session that
// owns the row, or the ticket a guest gets at POST /api/my-bookings — and keeps
// the direct code path for a caller holding no cookie at all.
//
// A signed-in customer who owns the row needs no code — the session already
// proves more than an emailed digit string does. See lib/otp.ts for the rules
// the code itself is held to.
//
// What comes back is the refill *offer*: how long is left, and what it costs.
// The customer still books their own slot afterwards through /booking?refill=…,
// which re-validates all of this server-side — nothing here is trusted later.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { bookings, services } from "@/lib/db/schema";
import { claimedWindows } from "@/lib/bookings";
import { halalasToSar } from "@/lib/money";
import { OTP_LENGTH } from "@/lib/otp";
import { refillDaysLeft, refillPriceHalalas, refillWindowEnd } from "@/lib/refill";
import { getSettings } from "@/lib/settings";
import { refuseBookingAction } from "@/lib/booking-auth";
import { clientIp, throttled } from "@/lib/throttle";

export const dynamic = "force-dynamic";

const body = z.object({
  code: z.string().trim().min(4).max(20),
  otp: z.string().trim().regex(new RegExp(`^\\d{${OTP_LENGTH}}$`), "invalid-otp")
    // Optional: a cookie may already carry the proof. The route decides when a
    // code is mandatory, not zod.
    .optional(),
});

export async function POST(request: Request) {
  // The reference is no longer sufficient on its own here, but an unauthorised
  // call still costs a lookup. Same budget as the read endpoint.
  if (throttled(`refill:${clientIp(request)}`, { max: 10 })) {
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

  const [row] = await db
    .select({
      id: bookings.id,
      customerId: bookings.customerId,
      startsAt: bookings.startsAt,
      status: bookings.status,
      refillOfBookingId: bookings.refillOfBookingId,
      servicePriceHalalas: services.priceHalalas,
      refillDays: services.refillDays,
    })
    .from(bookings)
    .leftJoin(services, eq(services.id, bookings.serviceId))
    .where(eq(bookings.code, code))
    .limit(1);

  if (!row) return NextResponse.json({ error: "wrong" }, { status: 401 });

  const refusal = await refuseBookingAction(row, parsed.data.otp);
  if (refusal) {
    return NextResponse.json({ error: refusal.error }, { status: refusal.status });
  }

  const spentOn = await claimedWindows([row.id]);
  const settings = await getSettings(["refill_discount_percent"]);

  const offer = {
    startsAt: row.startsAt,
    status: row.status,
    refillDays: row.refillDays ?? 0,
    alreadyRefilled: spentOn.has(row.id),
    isRefill: Boolean(row.refillOfBookingId),
  };
  const daysLeft = refillDaysLeft(offer);

  // The deadline shown to the customer, from the same function the rule uses —
  // it was worked out by hand here, which is exactly how a date and a countdown
  // drift apart.
  const expiresAt = daysLeft > 0 ? refillWindowEnd(offer) : null;

  return NextResponse.json({
    refill: {
      daysLeft,
      expiresAt: expiresAt?.toISOString() ?? null,
      priceSar: halalasToSar(
        refillPriceHalalas(row.servicePriceHalalas ?? 0, settings.refill_discount_percent),
      ),
      bookUrl: daysLeft > 0 ? `/booking?refill=${code}` : null,
    },
  });
}
