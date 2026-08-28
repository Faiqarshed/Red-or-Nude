// One booking, opened by a guest with its reference and a code from its inbox.
//
// The reference alone used to be the whole credential. It is generated
// server-side, printed once on the success screen and emailed to the address
// given at checkout (lib/payments/confirm.ts), so holding one is evidence you
// made the booking — but it is also forwardable, and it stays valid in that
// inbox forever. So the gate sits at the front door: a guest spends a code once
// here, and leaves with a thirty-minute ticket that carries the proof to the
// cancel, reschedule and refill calls that follow. Those routes accept the
// ticket and no longer accept a bare reference, which is what makes this code
// gate something rather than decorate the path.
//
// A signed-in customer needs no code: the session already proves who they are,
// and this route checks the booking is actually theirs before honouring it. In
// practice they never arrive here — my-bookings/page.tsx redirects them to
// /account — but the endpoint is public and must not care how it is reached.
//
// The response never echoes the name, phone or email back, and a reference
// opens *that* booking and nothing else. Both promises live in
// bookingSummaries() (lib/bookings.ts), shared with /account so neither screen
// can quietly start revealing more than the other.
//
// Note for group bookings: each guest's row has its own code, so a reference
// opens that guest's booking, not both halves of the bill.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { bookings } from "@/lib/db/schema";
import { bookingSummaries } from "@/lib/bookings";
import { mayActOnBooking } from "@/lib/account/guard";
import { BOOKING_COOKIE, BOOKING_TICKET_TTL_S, mintBookingTicket } from "@/lib/account/session";
import { OTP_LENGTH, bookingSubject, verifyOtp } from "@/lib/otp";
import { clientIp, throttled } from "@/lib/throttle";

export const dynamic = "force-dynamic";

const body = z.object({
  code: z.string().trim().min(4).max(20),
  // Optional in the schema because guest-ness is a cookie fact, not a body
  // fact. The route decides when it is mandatory, not zod.
  otp: z.string().trim().regex(new RegExp(`^\d{${OTP_LENGTH}}$`)).optional(),
});

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

  const [row] = await db
    .select({ id: bookings.id, customerId: bookings.customerId })
    .from(bookings)
    .where(eq(bookings.code, code))
    .limit(1);

  // Already carrying a credential: a session that owns the row, or the ticket
  // from an earlier verification here. The second case is what lets the screen
  // re-read a booking after cancelling or moving it without sending another
  // code — the same proof, still valid, for the same booking.
  if (row && (await mayActOnBooking(row))) {
    return NextResponse.json({ bookings: await bookingSummaries({ code }) });
  }

  // Asked before the reference is judged, so the answer says nothing about
  // whether it exists.
  if (!parsed.data.otp) {
    return NextResponse.json({ error: "otp-required" }, { status: 401 });
  }

  // From here every refusal is the same 401. An unknown reference must not be
  // distinguishable from a real one you cannot open — otherwise this endpoint
  // becomes the reference-existence oracle the code is meant to close.
  if (!row) return NextResponse.json({ error: "wrong" }, { status: 401 });

  const check = await verifyOtp(bookingSubject(row.id), parsed.data.otp);
  if (!check.ok) {
    return NextResponse.json(
      { error: check.reason },
      { status: check.reason === "too-many-attempts" ? 429 : 401 },
    );
  }

  const response = NextResponse.json({ bookings: await bookingSummaries({ code }) });
  response.cookies.set(BOOKING_COOKIE, await mintBookingTicket(row.id), {
    httpOnly: true, // nothing in the browser reads it; fetch sends it on its own
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: BOOKING_TICKET_TTL_S,
  });
  return response;
}
