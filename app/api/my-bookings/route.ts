// The customer's booking history, opened with a booking reference.
//
// Customers have no account, so the reference is the credential. It is generated
// server-side, printed once on the success screen and emailed to the address
// given at checkout (lib/payments/confirm.ts), so holding one is evidence you
// made the booking. That is also why the response never echoes the name, phone
// or email back: the reference proves someone booked, not who they are.

import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { bookings, services } from "@/lib/db/schema";
import { claimedWindows } from "@/lib/bookings";
import { halalasToSar } from "@/lib/money";
import { refillDaysLeft, refillPriceHalalas } from "@/lib/refill";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

const body = z.object({ code: z.string().trim().min(4).max(20) });

const HISTORY_LIMIT = 20;

// A reference is five characters of a 32-character alphabet. That is a large
// space, but not so large that an unthrottled endpoint couldn't be walked, and
// the prize is someone's appointment history.
//
// ponytail: an in-memory map, so it counts per serverless instance rather than
// globally, and it resets on cold start. Enough to stop a script; move it to the
// database or a shared counter if the logs ever show a real attempt.
const ATTEMPTS = new Map<string, number[]>();
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;

function throttled(ip: string): boolean {
  const now = Date.now();
  const recent = (ATTEMPTS.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  ATTEMPTS.set(ip, recent);

  // Stop the map growing without bound on a busy instance.
  if (ATTEMPTS.size > 5_000) ATTEMPTS.clear();

  return recent.length > MAX_ATTEMPTS;
}

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (throttled(ip)) return NextResponse.json({ error: "too-many" }, { status: 429 });

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const parsed = body.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const code = parsed.data.code.toUpperCase();

  const [anchor] = await db
    .select({ customerId: bookings.customerId })
    .from(bookings)
    .where(eq(bookings.code, code))
    .limit(1);

  // Unknown reference, or a booking with no customer attached — the same answer
  // either way, so a caller learns nothing from the difference.
  if (!anchor?.customerId) return NextResponse.json({ error: "not-found" }, { status: 404 });

  const rows = await db
    .select({
      id: bookings.id,
      code: bookings.code,
      startsAt: bookings.startsAt,
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
    .where(eq(bookings.customerId, anchor.customerId))
    .orderBy(desc(bookings.startsAt))
    .limit(HISTORY_LIMIT);

  const spentOn = await claimedWindows(rows.map((r) => r.id));

  const settings = await getSettings(["refill_discount_percent"]);
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
        // daysLeft 0 means no button — see refillDaysLeft().
        refill: {
          daysLeft,
          priceSar: halalasToSar(
            refillPriceHalalas(r.servicePriceHalalas ?? 0, settings.refill_discount_percent),
          ),
        },
      };
    }),
  });
}
