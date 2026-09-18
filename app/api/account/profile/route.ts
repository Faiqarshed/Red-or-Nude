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
import { birthdayField, nameField } from "@/lib/account/fields";
import { isValidSaudiMobile, toStoredPhone } from "@/lib/phone";
import { clientIp, throttled } from "@/lib/throttle";

export const dynamic = "force-dynamic";

const body = z.object({
  name: nameField,
  phone: z.string().trim().refine(isValidSaudiMobile, "invalid-phone"),
  /**
   * Null to clear it. Nullable rather than optional: a customer who filled this
   * in once must be able to take it back out, and an omitted field would
   * silently mean "leave it".
   */
  birthday: birthdayField.nullable(),
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

  // The phone is a contact detail on an account, not its identity, so another
  // row with the same number is no conflict and says nothing to anyone
  // (customers_guest_phone_unique only covers guest rows).
  await db
    .update(customers)
    .set({
      name: parsed.data.name,
      phone: toStoredPhone(parsed.data.phone),
      birthday: parsed.data.birthday,
      updatedAt: new Date(),
    })
    .where(eq(customers.id, customer.id));

  return NextResponse.json({ ok: true });
}
