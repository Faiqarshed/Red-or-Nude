// One booking, opened with its own reference.
//
// Customers have no account, so the reference is the credential. It is generated
// server-side, printed once on the success screen and emailed to the address
// given at checkout (lib/payments/confirm.ts), so holding one is evidence you
// made the booking. That is also why the response never echoes the name, phone
// or email back: the reference proves someone booked, not who they are.
//
// A reference opens *that* booking and nothing else. It used to resolve the code
// to a customer and return their whole history, which meant one leaked or
// guessed reference exposed every appointment that person had ever made — a much
// bigger prize for anyone walking the code space, and more than the holder of a
// single reference is entitled to.
//
// Note for group bookings: each guest's row has its own code, so a reference
// opens that guest's booking, not both halves of the bill.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { bookings, services } from "@/lib/db/schema";
import { claimedWindows } from "@/lib/bookings";
import { halalasToSar } from "@/lib/money";
import { refillDaysLeft } from "@/lib/refill";
import { canCancel, cancelDeadline } from "@/lib/cancellation";
import { getSettings } from "@/lib/settings";
import { clientIp, throttled } from "@/lib/throttle";

export const dynamic = "force-dynamic";

const body = z.object({ code: z.string().trim().min(4).max(20) });

export async function POST(request: Request) {
  // A reference is five characters of a 32-character alphabet — a large space,
  // but not one an unthrottled endpoint couldn't be walked. See lib/throttle.ts.
  if (throttled(`my-bookings:${clientIp(request)}`, { max: 10 })) {
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

  const rows = await db
    .select({
      id: bookings.id,
      code: bookings.code,
      branchId: bookings.branchId,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      status: bookings.status,
      ticketNo: bookings.ticketNo,
      serviceName: bookings.serviceName,
      totalHalalas: bookings.totalHalalas,
      refillOfBookingId: bookings.refillOfBookingId,
      // The live catalogue price, not the snapshot: the server prices a refill
      // off today's price list, so the button has to quote the same number.
      servicePriceHalalas: services.priceHalalas,
      refillDays: services.refillDays,
    })
    .from(bookings)
    .leftJoin(services, eq(services.id, bookings.serviceId))
    .where(eq(bookings.code, code))
    .limit(1);

  // Unknown reference. The response is deliberately the same shape of "no" the
  // throttle gives, so a caller learns nothing from the difference.
  if (rows.length === 0) return NextResponse.json({ error: "not-found" }, { status: 404 });

  const spentOn = await claimedWindows(rows.map((r) => r.id));
  const { cancel_cutoff_hours: cutoff } = await getSettings(["cancel_cutoff_hours"]);
  const now = new Date();

  return NextResponse.json({
    bookings: rows.map((r) => {
      const daysLeft = refillDaysLeft(
        {
          startsAt: r.startsAt,
          status: r.status,
          refillDays: r.refillDays ?? 0,
          alreadyRefilled: spentOn.has(r.id),
          isRefill: Boolean(r.refillOfBookingId),
          },
        now,
      );

      return {
        code: r.code,
        startsAt: r.startsAt.toISOString(),
        status: r.status,
        ticketNo: r.ticketNo,
        serviceName: r.serviceName,
        totalSar: halalasToSar(r.totalHalalas),
        isRefill: Boolean(r.refillOfBookingId),
        // Only *whether* a refill is on offer. The countdown, the price and the
        // booking link all sit behind the emailed code at
        // POST /api/my-bookings/refill — otherwise holding a forwarded reference
        // would be enough to read them, and the code would be gating nothing.
        hasRefill: daysLeft > 0,

        // The cancellation window (brief §2.6), decided here and not in the
        // browser: the buttons must never offer what the API would refuse.
        // `cancelBy` is sent even once the window has shut, so the screen can
        // explain *why* the buttons are gone rather than silently omitting them.
        canCancel: canCancel(r, cutoff, now),
        cancelBy: cancelDeadline(r, cutoff).toISOString(),
        // Only what the reschedule picker needs — which chair, and the customer's
        // own price, stay unsaid.
        branchId: r.branchId,
        durationMin: Math.round((r.endsAt.getTime() - r.startsAt.getTime()) / 60_000),
      };
    }),
  });
}
