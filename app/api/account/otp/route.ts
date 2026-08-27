// Request a sign-in code for an email address (brief §2.8).
//
// This is the only entry point to an account, so it is also the only place that
// could become an account-enumeration oracle. It does not:
//
//   **The response is identical whether or not the address has an account.**
//
// That is the whole reason sign-in and sign-up are one screen. Two screens
// means one of them says "that email is already registered" and the other says
// "no account found", and either sentence lets someone walk a list of addresses
// and learn who is a customer of this salon. Here, a code is sent to any
// syntactically valid address — the inbox is what distinguishes the cases, and
// only its owner can see it.
//
// Two throttles, because there are two abuse shapes, exactly as in
// ../../my-bookings/otp/route.ts:
//   • per IP — someone walking a list of addresses
//   • per email — someone using one known address to mailbomb its owner

import { NextResponse } from "next/server";
import { z } from "zod";
import { emailSubject, issueOtp, maskEmail } from "@/lib/otp";
import { sendOtpEmail } from "@/lib/otp-email";
import { clientIp, throttled } from "@/lib/throttle";

export const dynamic = "force-dynamic";

const body = z.object({
  email: z.string().trim().email().max(200),
  lang: z.enum(["ar", "en"]).optional(),
});

export async function POST(request: Request) {
  if (throttled(`account-otp:${clientIp(request)}`, { max: 6 })) {
    return NextResponse.json({ error: "too-many" }, { status: 429 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const parsed = body.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "invalid-email" }, { status: 400 });

  const email = parsed.data.email.toLowerCase();

  // A code lives ten minutes; one email per address per minute is plenty, and
  // no IP limit alone stops someone with a known address from being a nuisance.
  if (throttled(`account-otp-email:${email}`, { max: 1 })) {
    // Reported honestly rather than silently dropped: they are waiting on an
    // email that is already on its way, and "check your inbox" is the truth.
    return NextResponse.json({ sent: true, sentTo: maskEmail(email), throttled: true });
  }

  const code = await issueOtp(emailSubject(email));
  const mail = await sendOtpEmail({
    to: email,
    code,
    lang: parsed.data.lang ?? "ar",
  });

  if (!mail.ok) {
    // A code that never arrives leaves the customer at a form they cannot pass,
    // so this surfaces rather than only logging — the same call the booking OTP
    // route makes.
    console.error("[account] could not email a sign-in code:", mail.reason, mail.detail ?? "");
    return NextResponse.json({ error: "mail-failed" }, { status: 502 });
  }

  return NextResponse.json({ sent: true, sentTo: maskEmail(email) });
}
