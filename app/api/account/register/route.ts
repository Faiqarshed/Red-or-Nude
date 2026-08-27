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
import { clientIp, throttled } from "@/lib/throttle";

export const dynamic = "force-dynamic";

const body = z.object({
  ticket: z.string().min(1).max(4000),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().refine(isValidSaudiMobile, "invalid-phone"),
  /**
   * Brief §2.8 — captured at signup, for reminders and offers. Optional: a
   * customer who would rather not say still gets an account. `YYYY-MM-DD`,
   * which is what <input type="date"> submits and what a `date` column stores.
   */
  birthday: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
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

  const phone = toStoredPhone(parsed.data.phone);

  let customer;
  try {
    // Conflict on phone, which is the key checkout already upserts on
    // (lib/bookings.ts). So a customer who has booked as a guest from this
    // number keeps their row — and with it their booking history — rather than
    // starting a second one beside it.
    [customer] = await db
      .insert(customers)
      .values({
        phone,
        name: parsed.data.name,
        email,
        birthday: parsed.data.birthday ?? null,
        emailVerifiedAt: new Date(),
        lang: parsed.data.lang ?? "ar",
      })
      .onConflictDoUpdate({
        target: customers.phone,
        set: {
          name: parsed.data.name,
          email,
          birthday: parsed.data.birthday ?? undefined,
          emailVerifiedAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning();
  } catch (err) {
    // Almost certainly the partial unique index: this phone's row already
    // carries a *different* verified address. One person, one account.
    console.error("[account] could not create an account", err);
    return NextResponse.json({ error: "phone-in-use" }, { status: 409 });
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
