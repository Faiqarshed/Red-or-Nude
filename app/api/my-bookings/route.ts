// One booking, opened with its own reference.
//
// A guest has no account, so the reference is the credential. It is generated
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
// What comes back is shaped by bookingSummaries() in lib/bookings.ts, shared
// with /account. The privacy decision above lives there now, in one place, so it
// cannot be true on one screen and forgotten on the other.
//
// Note for group bookings: each guest's row has its own code, so a reference
// opens that guest's booking, not both halves of the bill.

import { NextResponse } from "next/server";
import { z } from "zod";
import { bookingSummaries } from "@/lib/bookings";
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

  const bookings = await bookingSummaries({ code: parsed.data.code.toUpperCase() });

  // Unknown reference. The response is deliberately the same shape of "no" the
  // throttle gives, so a caller learns nothing from the difference.
  if (bookings.length === 0) return NextResponse.json({ error: "not-found" }, { status: 404 });

  return NextResponse.json({ bookings });
}
