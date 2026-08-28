// Who is signed in on the customer side. The mirror of lib/auth/guard.ts, for
// the other audience — and deliberately sharing nothing with it.

import "server-only";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { ACCOUNT_COOKIE, BOOKING_COOKIE, readBookingTicket, readSession } from "./session";

export type SessionCustomer = {
  id: string;
  name: string | null;
  email: string;
  phone: string;
  birthday: string | null;
  lang: "ar" | "en";
};

/**
 * The signed-in customer, or null.
 *
 * The row is read every time rather than trusting the token's contents, which
 * is what makes `blocked` an immediate revocation: a blocked customer's next
 * request is signed out, without waiting thirty days for their token to lapse.
 * Nothing is lost by the read — every caller needs the row anyway.
 */
export async function currentCustomer(): Promise<SessionCustomer | null> {
  const token = cookies().get(ACCOUNT_COOKIE)?.value;
  const id = await readSession(token);
  if (!id) return null;

  const [row] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, id))
    .limit(1);

  // No row (deleted), blocked, or an account whose email was never verified —
  // the last one means the token outlived whatever made it valid.
  if (!row || row.blocked || !row.emailVerifiedAt || !row.email) return null;

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    // `date` comes back as a plain `YYYY-MM-DD` string, which is what the form
    // wants and what an <input type="date"> expects. Do not turn it into a Date.
    birthday: row.birthday,
    lang: row.lang,
  };
}


/**
 * Whether this request is allowed to act on a booking — cancel it, move it, or
 * read its refill offer.
 *
 * Two credentials, one rule, written once because cancel and reschedule both
 * need it and a rule that disagrees with itself across two routes is how a
 * booking becomes cancellable from one URL and not the other:
 *
 *   • a signed-in customer, *if the booking is theirs*. The session proves who
 *     you are and nothing more — without the equality any signed-in customer
 *     could cancel any booking whose reference they knew, which would be weaker
 *     than the guest path it replaced, not stronger. It is also the predicate
 *     /account lists by, so the invariant is: every card on that screen is
 *     actionable, and nothing else is.
 *
 *   • a guest holding the ticket minted at POST /api/my-bookings, which they
 *     got by spending a code sent to the booking's own inbox. Scoped to one
 *     booking id, so a ticket for one appointment does not open another.
 *
 * A group shares one customerId — createBookings() writes the booker's id to
 * every member — so ownership of the anchor is ownership of the group, and
 * cancelling as a unit needs no second check.
 *
 * A booking whose customer row was deleted (`customerId` is nullable) satisfies
 * neither credential and needs a receptionist. Correct: there is nothing left
 * to prove ownership with.
 */
export async function mayActOnBooking(booking: {
  id: string;
  customerId: string | null;
}): Promise<boolean> {
  const customer = await currentCustomer();
  if (customer) return booking.customerId === customer.id;

  const ticketFor = await readBookingTicket(cookies().get(BOOKING_COOKIE)?.value);
  return ticketFor === booking.id;
}
