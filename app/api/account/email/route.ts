// Step one of changing the email on an account: send a code to the NEW address.
//
// Why this is not just a field on the profile form: the email is the identity.
// It is what sign-in resolves, and it is where invoices go. Letting a signed-in
// customer set it to an address they don't own would let them
//
//   • point another person's inbox at their invoices, and
//   • squat that person's address — the partial unique index on verified
//     emails means the real owner could then never sign up.
//
// So the new address has to prove itself exactly as the first one did, using
// the same code machinery. The account is not touched until ./confirm/route.ts.

import { NextResponse } from "next/server";
import { and, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { emailSubject, issueOtp, maskEmail } from "@/lib/otp";
import { sendOtpEmail } from "@/lib/otp-email";
import { currentCustomer } from "@/lib/account/guard";
import { clientIp, throttled } from "@/lib/throttle";

export const dynamic = "force-dynamic";

const body = z.object({
  email: z.string().trim().email().max(200),
  lang: z.enum(["ar", "en"]).optional(),
});

export async function POST(request: Request) {
  const customer = await currentCustomer();
  if (!customer) return NextResponse.json({ error: "signed-out" }, { status: 401 });

  if (throttled(`account-email:${clientIp(request)}`, { max: 6 })) {
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
  if (email === customer.email.toLowerCase()) {
    return NextResponse.json({ error: "same-email" }, { status: 400 });
  }

  // Unlike sign-in, this one *does* say whether the address is taken — and it
  // is not an enumeration hole, because the caller must already hold a session.
  // Saying so here is better than sending a code that ./confirm will refuse.
  const [taken] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(sql`lower(${customers.email}) = ${email}`, isNotNull(customers.emailVerifiedAt)))
    .limit(1);
  if (taken) return NextResponse.json({ error: "already-registered" }, { status: 409 });

  if (throttled(`account-email-to:${email}`, { max: 1 })) {
    return NextResponse.json({ sent: true, sentTo: maskEmail(email), throttled: true });
  }

  const code = await issueOtp(emailSubject(email));
  const mail = await sendOtpEmail({ to: email, code, lang: parsed.data.lang ?? customer.lang });

  if (!mail.ok) {
    console.error("[account] could not email a change-of-address code:", mail.reason);
    return NextResponse.json({ error: "mail-failed" }, { status: 502 });
  }

  return NextResponse.json({ sent: true, sentTo: maskEmail(email) });
}
