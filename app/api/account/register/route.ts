// Finish signing up: the profile behind a verified address.
//
// The address is NOT taken from the body. It comes out of the ticket, which was
// minted by ../verify/route.ts only after a correct code — so a caller cannot
// register an inbox they never proved they own by posting a different address
// here. That is the entire security property of this route.

import { NextResponse } from "next/server";
import { and, isNotNull, isNull, sql } from "drizzle-orm";
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

  /**
   * The phone number is a label, not a key.
   *
   * Nothing on this route proves the caller owns the number — they typed it.
   * The address is the only thing anyone has proved, so the address is the only
   * thing allowed to resolve an existing account. A typed number may *claim* a
   * guest row, which is the point of the upsert below, and may never open one
   * that already belongs to somebody.
   *
   * Without this, signing up with a stranger's number overwrote their name,
   * email and verification in place and handed over a session for their row —
   * bookings, loyalty ledger and all — the id never changing. The only secret
   * needed was a phone number, which is not a secret.
   *
   * Note what does NOT stop it. `customers_account_email_unique` forbids two
   * *rows* holding one verified address; it cannot see a single row's address
   * being changed to one nobody else holds, so the insert never threw and the
   * `phone-in-use` below was unreachable. A constraint that guards the wrong
   * thing reads exactly like a constraint that guards the right one.
   *
   * WHEN SMS OTP LANDS (brief §2.8 calls it a later upgrade), this inverts: the
   * phone becomes the proved identity and the primary way in, and the address
   * drops to a contact detail and a recovery channel. Three things have to move
   * together on that day, or this hole reopens facing the other way:
   *
   *   1. whichever channel is proved is the one allowed to resolve an account —
   *      this check follows the OTP, it does not follow the column;
   *   2. an account must keep at least one proved channel, so releasing a
   *      recycled number is only safe once its owner has a verified address;
   *   3. the unproved channel goes back to being a label, and labels reserve
   *      nothing — locking one lets a stranger squat somebody's number.
   *
   * Enforced by the `setWhere` on the upsert below and nowhere else. A SELECT
   * ahead of it would read better and buy nothing: it races the write it
   * guards, and the write already produces the identical 409 without it — so
   * it would only add a round trip to every registration that was never in
   * danger.
   */

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
        // The guarantee, as opposed to the message. The check above races —
        // two signups for one number can both read "no account here" — so the
        // update itself refuses any row that has become an account in the
        // meantime. Postgres evaluates this against the conflicting row while
        // holding it, which the SELECT cannot do.
        setWhere: isNull(customers.emailVerifiedAt),
      })
      .returning();
  } catch (err) {
    // The partial unique index on verified addresses, or anything else the
    // database refused. Reported as a conflict rather than a 500: from the
    // caller's side the number is spoken for either way.
    console.error("[account] could not create an account", err);
    return NextResponse.json({ error: "phone-in-use" }, { status: 409 });
  }

  // `setWhere` declined to update, so nothing came back: the row turned into an
  // account between the check and the write. Same answer as the check.
  if (!customer) return NextResponse.json({ error: "phone-in-use" }, { status: 409 });

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
