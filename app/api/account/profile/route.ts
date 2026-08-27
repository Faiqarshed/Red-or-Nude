// Edit the profile: name, birthday, mobile.
//
// Not email. That one is the identity — it is what sign-in resolves and where
// invoices go — so changing it has to prove ownership of the *new* address
// first. See ../email/route.ts.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { currentCustomer } from "@/lib/account/guard";
import { isValidSaudiMobile, toStoredPhone } from "@/lib/phone";
import { clientIp, throttled } from "@/lib/throttle";

export const dynamic = "force-dynamic";

const body = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().refine(isValidSaudiMobile, "invalid-phone"),
  /**
   * `YYYY-MM-DD`, or null to clear it. Nullable rather than optional: a
   * customer who filled this in once must be able to take it back out, and an
   * omitted field would silently mean "leave it".
   */
  birthday: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
});

export async function POST(request: Request) {
  const customer = await currentCustomer();
  if (!customer) return NextResponse.json({ error: "signed-out" }, { status: 401 });

  if (throttled(`account-profile:${clientIp(request)}`, { max: 20 })) {
    return NextResponse.json({ error: "too-many" }, { status: 429 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const parsed = body.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues.map((i) => i.path.join(".")) },
      { status: 400 },
    );
  }

  const phone = toStoredPhone(parsed.data.phone);

  // `customers.phone` is unique and is what guest checkout upserts on, so
  // moving onto a number that already belongs to someone else would merge two
  // people. Checked before the write so the customer gets a sentence rather
  // than a 500 out of the constraint.
  if (phone !== customer.phone) {
    const [taken] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.phone, phone))
      .limit(1);
    if (taken) return NextResponse.json({ error: "phone-in-use" }, { status: 409 });
  }

  try {
    await db
      .update(customers)
      .set({
        name: parsed.data.name,
        phone,
        birthday: parsed.data.birthday,
        updatedAt: new Date(),
      })
      .where(eq(customers.id, customer.id));
  } catch (err) {
    // Lost the race against another request claiming that number.
    console.error("[account] could not save the profile", err);
    return NextResponse.json({ error: "phone-in-use" }, { status: 409 });
  }

  return NextResponse.json({ ok: true });
}
