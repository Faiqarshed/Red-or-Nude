// Spend a sign-in code.
//
// Two outcomes, and which one you get is decided *after* the code is checked —
// never before. Nothing on this route tells an unauthenticated caller whether
// an address has an account; only someone who read the code learns that, and
// they own the inbox, so it was never a secret from them.
//
//   • the address already has an account → signed in, cookie set
//   • it doesn't → a 15-minute ticket, and the screen asks for the profile
//
// The ticket exists because the code is consumed by the first successful verify
// while `customers.phone` is NOT NULL: the row can't be created until the name
// and phone arrive on a second request, and that request has to prove the first
// one happened. See lib/account/session.ts.

import { NextResponse } from "next/server";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { OTP_LENGTH, emailSubject, verifyOtp } from "@/lib/otp";
import { ACCOUNT_COOKIE, SESSION_TTL_S, mintSession, mintSignupTicket } from "@/lib/account/session";
import { clientIp, throttled } from "@/lib/throttle";

export const dynamic = "force-dynamic";

const body = z.object({
  email: z.string().trim().email().max(200),
  code: z.string().trim().length(OTP_LENGTH),
});

export async function POST(request: Request) {
  // lib/otp.ts burns a code after five wrong guesses, which caps the attack on
  // any one code. This caps the attack across *many* codes: without it someone
  // could request a fresh code and spend five guesses, forever.
  if (throttled(`account-verify:${clientIp(request)}`, { max: 10 })) {
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

  // A verified address resolves to at most one row — that is what the partial
  // unique index on lower(email) guarantees, and why it only covers verified
  // addresses (see lib/db/schema.ts).
  const [existing] = await db
    .select({ id: customers.id, blocked: customers.blocked })
    .from(customers)
    .where(
      and(
        sql`lower(${customers.email}) = ${email}`,
        isNotNull(customers.emailVerifiedAt),
      ),
    )
    .limit(1);

  if (!existing) {
    return NextResponse.json({
      ok: true,
      needsProfile: true,
      ticket: await mintSignupTicket(email),
    });
  }

  // A blocked customer holds a correct code and still does not get a session.
  // currentCustomer() would refuse them on the next request anyway; refusing
  // here means they see an honest answer instead of a session that does nothing.
  if (existing.blocked) return NextResponse.json({ error: "blocked" }, { status: 403 });

  const response = NextResponse.json({ ok: true, needsProfile: false });
  response.cookies.set(ACCOUNT_COOKIE, await mintSession(existing.id), {
    httpOnly: true, // so an XSS bug cannot read the session
    secure: process.env.NODE_ENV === "production",
    // `lax`, not `strict`: customers arrive here from a link in the code email,
    // and `strict` drops the cookie on that navigation — showing them a sign-in
    // form they just completed.
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_S,
  });

  // Record the sign-in. Bookkeeping, never a reason to fail one.
  await db
    .update(customers)
    .set({ updatedAt: new Date() })
    .where(eq(customers.id, existing.id))
    .catch((err) => console.error("[account] signed in but could not stamp the row:", err));

  return response;
}
