// The wallet: money a customer holds with the salon (docs/WALLET-PLAN.md).
//
// A ledger, wallet_txns, with no balance column. Her balance is SUM(delta) over
// her rows *for one email*: credit belongs to the email of the booking or gift
// card it came from, and only a sign-in with that email reaches it.
//
// Every write is one row, and every repeat of a write is refused by a unique
// index on that table rather than by a read before it.

import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db";
import { walletTxns } from "@/lib/db/schema";

/**
 * What she holds. `total` can be below zero, when a payment behind her credit
 * went back to her card after she spent it; she is never shown that, so what she
 * sees and can spend is `available`.
 */
export async function walletBalance(
  customerId: string,
  ownerEmail: string,
  executor: Pick<typeof db, "select"> = db,
): Promise<{ total: number; available: number }> {
  const [row] = await executor
    .select({ total: sql<number>`coalesce(sum(${walletTxns.deltaHalalas}), 0)::int` })
    .from(walletTxns)
    .where(
      and(eq(walletTxns.customerId, customerId), eq(walletTxns.ownerEmail, ownerEmail.trim().toLowerCase())),
    );
  return { total: row.total, available: Math.max(0, row.total) };
}

/**
 * The only way to spend. Takes the customer row lock and reads the balance
 * inside it, so two checkouts in two tabs cannot both spend one balance: the
 * second waits here and sees the first's spend.
 *
 * Returns the spend row's id, or null when she does not have that much.
 * A checkout's first spend is one per booking or payment (the unique indexes),
 * so a retried request throws rather than spending twice. `reSpendOf` is a
 * revived checkout taking a released spend again: one per release.
 */
export async function spendWallet(
  tx: Tx,
  customerId: string,
  ownerEmail: string,
  halalas: number,
  on: { bookingId?: string; paymentId?: string; reSpendOf?: string },
): Promise<string | null> {
  if (!Number.isInteger(halalas) || halalas <= 0) return null;
  await tx.execute(sql`select 1 from customers where id = ${customerId} for update`);

  if ((await walletBalance(customerId, ownerEmail, tx)).available < halalas) return null;

  const [row] = await tx
    .insert(walletTxns)
    .values({
      customerId,
      ownerEmail: ownerEmail.trim().toLowerCase(),
      deltaHalalas: -halalas,
      reason: "spend",
      bookingId: on.bookingId,
      paymentId: on.paymentId,
      reversesId: on.reSpendOf,
    })
    .returning({ id: walletTxns.id });
  return row.id;
}

/**
 * Give a spend back: its checkout was abandoned, declined or lapsed. Called in
 * the transaction of the write that ends the checkout. A second call for the
 * same spend writes nothing (wallet_txns_reverses_unique), so every path that
 * ends a checkout may call it.
 */
export async function releaseSpend(tx: Tx, spendId: string): Promise<void> {
  const [spend] = await tx
    .select()
    .from(walletTxns)
    .where(and(eq(walletTxns.id, spendId), eq(walletTxns.reason, "spend")));
  if (!spend) return;

  await tx
    .insert(walletTxns)
    .values({
      customerId: spend.customerId,
      ownerEmail: spend.ownerEmail,
      deltaHalalas: -spend.deltaHalalas,
      reason: "release",
      bookingId: spend.bookingId,
      paymentId: spend.paymentId,
      reversesId: spend.id,
    })
    .onConflictDoNothing();
}
