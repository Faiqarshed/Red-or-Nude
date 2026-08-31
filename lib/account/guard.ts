// Who is signed in on the customer side. The mirror of lib/auth/guard.ts, for
// the other audience — and deliberately sharing nothing with it.

import "server-only";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { ACCOUNT_COOKIE, readSession } from "./session";

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
