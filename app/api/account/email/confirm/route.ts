// Step two of changing the email: spend the code sent to the new address.
//
// Only now is the account touched. `email_verified_at` is re-stamped, because
// what was verified is *this* address — carrying the old timestamp forward
// would record that an address was proved on a day it wasn't.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { emailField } from "@/lib/account/fields";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { OTP_LENGTH, emailSubject, verifyOtp } from "@/lib/otp";
import { currentCustomer, emailUsedByOther } from "@/lib/account/guard";
import { clientIp, throttled } from "@/lib/throttle";

export const dynamic = "force-dynamic";

const body = z.object({
  email: emailField,
  code: z.string().trim().length(OTP_LENGTH),
});

export async function POST(request: Request) {
  const customer = await currentCustomer();
  if (!customer) return NextResponse.json({ error: "signed-out" }, { status: 401 });

  if (throttled(`account-email-confirm:${clientIp(request)}`, { max: 10 })) {
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

  const email = parsed.data.email.toLowerCase();

  const check = await verifyOtp(emailSubject(email), parsed.data.code);
  if (!check.ok) return NextResponse.json({ error: check.reason }, { status: 401 });

  // Re-checked after the code, not only before it: someone else may have
  // finished claiming this address while the customer was reading their inbox.
  if (await emailUsedByOther(email, customer.id)) {
    return NextResponse.json({ error: "email-in-use" }, { status: 409 });
  }

  try {
    await db
      .update(customers)
      .set({ email, emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(customers.id, customer.id));
  } catch (err) {
    // The partial unique index caught a race the check above just missed.
    console.error("[account] could not change the address", err);
    return NextResponse.json({ error: "email-in-use" }, { status: 409 });
  }

  // The session cookie carries the customer id, not the address, so it survives
  // the change untouched — no re-sign-in, and other devices stay signed in too.
  return NextResponse.json({ ok: true, email });
}
