// Verify a code and return the booking's refill details.
//
// This is the only endpoint that reveals anything beyond a booking's own
// summary, which is why it needs the code from the customer's inbox as well as
// the reference. See lib/otp.ts for the rules the code itself is held to.
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
import { OTP_LENGTH, bookingSubject, verifyOtp } from "@/lib/otp";
import { refillDaysLeft, refillPriceHalalas } from "@/lib/refill";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

const body = z.object({
  code: z.string().trim().min(4).max(20),
  otp: z.string().trim().regex(new RegExp(`^\\d{${OTP_LENGTH}}$`), "invalid-otp"),
});

export async function POST(request: Request) {
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
      startsAt: bookings.startsAt,
      status: bookings.status,
      refillOfBookingId: bookings.refillOfBookingId,
      refillExpiresAt: bookings.refillExpiresAt,
      servicePriceHalalas: services.priceHalalas,
      refillDays: services.refillDays,
    })
    .from(bookings)
    .leftJoin(services, eq(services.id, bookings.serviceId))
    .where(eq(bookings.code, code))
    .limit(1);

  // Same answer as a wrong code: an unknown reference must not be distinguishable
  // from a real one with the wrong OTP.
  if (!row) return NextResponse.json({ error: "wrong" }, { status: 401 });

  const check = await verifyOtp(bookingSubject(row.id), parsed.data.otp);
  if (!check.ok) {
    const status = check.reason === "too-many-attempts" ? 429 : 401;
    return NextResponse.json({ error: check.reason }, { status });
  }

  const spentOn = await claimedWindows([row.id]);
  const settings = await getSettings(["refill_discount_percent"]);

  const daysLeft = refillDaysLeft({
    startsAt: row.startsAt,
    status: row.status,
    refillDays: row.refillDays ?? 0,
    alreadyRefilled: spentOn.has(row.id),
    isRefill: Boolean(row.refillOfBookingId),
    expiresAt: row.refillExpiresAt,
  });

  // The deadline shown to the customer, computed the same way the rule does so
  // the date and the countdown can never disagree.
  const expiresAt =
    daysLeft > 0
      ? (row.refillExpiresAt ??
        new Date(row.startsAt.getTime() + (row.refillDays ?? 0) * 86_400_000))
      : null;

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
