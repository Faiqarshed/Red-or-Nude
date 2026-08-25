// Request a verification code for a booking.
//
// Two throttles, because this endpoint has two different abuse shapes:
//   • per IP — someone walking the reference space
//   • per booking — someone who knows one reference using it to mailbomb the
//     customer, which no IP limit alone prevents
//
// The response never says whether the reference exists. An unknown code and a
// known one both return the same shape, so this cannot be used to confirm that a
// booking is real — the throttle would otherwise be the only thing standing
// between a guessed reference and a yes/no oracle.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { bookings, customers } from "@/lib/db/schema";
import { bookingSubject, issueOtp, maskEmail } from "@/lib/otp";
import { sendOtpEmail } from "@/lib/otp-email";

export const dynamic = "force-dynamic";

const body = z.object({ code: z.string().trim().min(4).max(20) });

const IP_WINDOW_MS = 60_000;
const IP_MAX = 6;
/** A code lives 10 minutes; one email per booking per minute is plenty. */
const BOOKING_COOLDOWN_MS = 60_000;

// ponytail: in-memory, so these count per serverless instance and reset on cold
// start — the same trade-off documented in ../route.ts. Enough to stop a script;
// move to the database if the logs ever show a real attempt.
const IP_HITS = new Map<string, number[]>();
const BOOKING_LAST = new Map<string, number>();

function ipThrottled(ip: string): boolean {
  const now = Date.now();
  const recent = (IP_HITS.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
  recent.push(now);
  IP_HITS.set(ip, recent);
  if (IP_HITS.size > 5_000) IP_HITS.clear();
  return recent.length > IP_MAX;
}

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (ipThrottled(ip)) return NextResponse.json({ error: "too-many" }, { status: 429 });

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

  // Deliberately indistinguishable from success. Someone guessing references
  // learns nothing from this response; the real customer gets an email.
  const opaque = NextResponse.json({ sent: true, sentTo: null });
  if (!row?.customerId) return opaque;

  const [customer] = await db
    .select({ email: customers.email, name: customers.name, lang: customers.lang })
    .from(customers)
    .where(eq(customers.id, row.customerId))
    .limit(1);

  const email = customer?.email?.trim();
  if (!email) return opaque;

  const last = BOOKING_LAST.get(row.id) ?? 0;
  if (Date.now() - last < BOOKING_COOLDOWN_MS) {
    // Already sent one moments ago. Reported honestly — the customer is waiting
    // on an email they will receive, and telling them to wait beats silence.
    return NextResponse.json({ sent: true, sentTo: maskEmail(email), throttled: true });
  }
  if (BOOKING_LAST.size > 5_000) BOOKING_LAST.clear();
  BOOKING_LAST.set(row.id, Date.now());

  const otp = await issueOtp(bookingSubject(row.id));
  const mail = await sendOtpEmail({
    to: email,
    toName: customer.name,
    code: otp,
    lang: customer.lang ?? "ar",
  });

  if (!mail.ok) {
    // Unlike an invoice, a code that never arrives leaves the customer stuck at
    // a dialog they cannot pass, so this one surfaces rather than only logging.
    console.error(`[otp] could not email a code for ${code}:`, mail.reason, mail.detail ?? "");
    return NextResponse.json({ error: "mail-failed" }, { status: 502 });
  }

  return NextResponse.json({ sent: true, sentTo: maskEmail(email) });
}
