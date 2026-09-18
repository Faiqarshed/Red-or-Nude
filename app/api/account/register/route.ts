// Finish signing up: the profile behind a verified address.
//
// The address is NOT taken from the body. It comes out of the ticket, which was
// minted by ../verify/route.ts only after a correct code — so a caller cannot
// register an inbox they never proved they own by posting a different address
// here. That is the entire security property of this route.

import { NextResponse } from "next/server";
import { and, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { isValidSaudiMobile, toStoredPhone } from "@/lib/phone";
import { ACCOUNT_COOKIE, SESSION_TTL_S, mintSession, readSignupTicket } from "@/lib/account/session";
import { birthdayField, nameField } from "@/lib/account/fields";
import { createAccount } from "@/lib/account/create";
import { clientIp, throttled } from "@/lib/throttle";

export const dynamic = "force-dynamic";

const body = z.object({
  ticket: z.string().min(1).max(4000),
  name: nameField,
  phone: z.string().trim().refine(isValidSaudiMobile, "invalid-phone"),
  /**
   * Brief §2.8 — captured at signup, for reminders and offers. Optional: a
   * customer who would rather not say still gets an account.
   */
  birthday: birthdayField.nullable().optional(),
  lang: z.enum(["ar", "en"]).optional(),
});

export async function POST(request: Request) {
  if (throttled(`account-register:${clientIp(request)}`, { max: 10 })) {
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

  const email = await readSignupTicket(parsed.data.ticket);
  // Expired, tampered with, or a session token someone tried to reuse here.
  if (!email) return NextResponse.json({ error: "ticket-expired" }, { status: 401 });

  // Someone else finished signing up with this address while this ticket sat in
  // a tab. Checked before the write so they get a sentence rather than a 500
  // from the partial unique index.
  const [taken] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(sql`lower(${customers.email}) = ${email}`, isNotNull(customers.emailVerifiedAt)))
    .limit(1);
  if (taken) return NextResponse.json({ error: "already-registered" }, { status: 409 });

  // Every guest booking made under this address comes with her, whatever phone
  // it used; the phone itself never picks rows. See lib/account/create.ts.
  let customer;
  try {
    customer = await createAccount({
      email,
      name: parsed.data.name,
      phone: toStoredPhone(parsed.data.phone),
      birthday: parsed.data.birthday ?? null,
      lang: parsed.data.lang ?? "ar",
    });
  } catch (err) {
    // customers_account_email_unique: the same address finished signing up in
    // another tab a moment ago.
    console.error("[account] could not create an account", err);
    return NextResponse.json({ error: "already-registered" }, { status: 409 });
  }

  if (customer.blocked) return NextResponse.json({ error: "blocked" }, { status: 403 });

  const response = NextResponse.json({ ok: true });
  response.cookies.set(ACCOUNT_COOKIE, await mintSession(customer.id), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_S,
  });
  return response;
}
