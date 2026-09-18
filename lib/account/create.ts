// Turning a verified address into an account.

import "server-only";
import { and, desc, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customerPacks, customers, loyaltyTxns } from "@/lib/db/schema";

export type AccountProfile = {
  email: string;
  name: string;
  phone: string;
  birthday: string | null;
  lang: "ar" | "en";
};

/**
 * Create the account for a proven `email`, folding in every guest row booked
 * under that address, whatever phone each used.
 *
 * The address is the proof: she just read a code sent there, and each of those
 * bookings sent its confirmation to the same inbox. The phone proves nothing,
 * so it plays no part in which rows are hers (customers_guest_phone_unique).
 *
 * The newest guest row becomes the account; the others' bookings, points and
 * memberships move onto it and the empty rows are deleted, all in one
 * transaction. A block on any of them carries over, so merging can't lift one,
 * and admin notes are kept together.
 *
 * Throws on customers_account_email_unique, when the same address finished
 * signing up in another tab a moment ago.
 */
export async function createAccount(p: AccountProfile) {
  const email = p.email.toLowerCase();

  return db.transaction(async (tx) => {
    const guests = await tx
      .select({ id: customers.id, blocked: customers.blocked, notes: customers.notes })
      .from(customers)
      .where(and(sql`lower(${customers.email}) = ${email}`, isNull(customers.emailVerifiedAt)))
      .orderBy(desc(customers.updatedAt))
      .for("update");

    const profile = {
      email,
      name: p.name,
      phone: p.phone,
      birthday: p.birthday,
      emailVerifiedAt: new Date(),
      updatedAt: new Date(),
    };

    const [keep, ...rest] = guests;
    if (!keep) {
      const [created] = await tx.insert(customers).values({ ...profile, lang: p.lang }).returning();
      return created;
    }

    if (rest.length) {
      const ids = rest.map((g) => g.id);
      await tx.update(bookings).set({ customerId: keep.id }).where(inArray(bookings.customerId, ids));
      await tx.update(loyaltyTxns).set({ customerId: keep.id }).where(inArray(loyaltyTxns.customerId, ids));
      await tx.update(customerPacks).set({ customerId: keep.id }).where(inArray(customerPacks.customerId, ids));
      await tx.delete(customers).where(inArray(customers.id, ids));
    }

    const [account] = await tx
      .update(customers)
      .set({
        ...profile,
        blocked: guests.some((g) => g.blocked),
        notes: guests.map((g) => g.notes?.trim()).filter(Boolean).join("\n\n") || null,
      })
      .where(sql`${customers.id} = ${keep.id}`)
      .returning();
    return account;
  });
}
