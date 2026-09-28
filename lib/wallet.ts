// The wallet: money a customer holds with the salon (docs/WALLET-PLAN.md).
//
// A ledger, wallet_txns, with no balance column. Her balance is SUM(delta) over
// her rows *for one email*: credit belongs to the email of the booking or gift
// card it came from, and only a sign-in with that email reaches it.
//
// Every write is one row, and every repeat of a write is refused by a unique
// index on that table rather than by a read before it.

import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db";
import { bookings, customers, payments, walletDecisions, walletTxns } from "@/lib/db/schema";
import { getSettings } from "@/lib/settings";

/** Whether the wallet is live (`wallet_launched_at`). */
export async function walletLaunched(): Promise<boolean> {
  return (await getSettings(["wallet_launched_at"])).wallet_launched_at !== "";
}

/**
 * A case the salon has not decided yet (docs/WALLET-PLAN.md, open questions).
 * Thrown rather than guessed at; the caller refuses with "held". Only reachable
 * after launch, and launch waits for every one to be answered.
 */
export class WalletHeld extends Error {}

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

/**
 * Credit the wallet for cancelled bookings: per booking, what she paid on it by
 * card plus what her wallet paid, to the email the booking was made under.
 * Call in the transaction that moved the bookings to `cancelled`.
 *
 * One cancel credit per booking (wallet_txns_cancel_unique), so a repeat
 * writes nothing. An unpaid hold credits nothing. Money on a booking with no
 * customer goes to the owner (wallet_decisions). A booking made before
 * bookings kept their email is held: open question 6.
 */
export async function creditCancelled(
  tx: Tx,
  bookingIds: string[],
  reason: "cancel-customer" | "cancel-salon",
  note?: string,
): Promise<number> {
  if (bookingIds.length === 0) return 0;

  const paidOn = and(eq(payments.bookingId, bookings.id), eq(payments.status, "paid"));
  const rows = await tx
    .select({
      id: bookings.id,
      customerId: bookings.customerId,
      customerEmail: bookings.customerEmail,
      walletPart: bookings.walletDiscountHalalas,
      cardPart: sql<number>`(select coalesce(sum(${payments.amountHalalas}), 0)::int from ${payments} where ${paidOn})`,
      paymentId: sql<string | null>`(select ${payments.id} from ${payments} where ${paidOn} limit 1)`,
    })
    .from(bookings)
    .where(inArray(bookings.id, bookingIds));

  let credited = 0;
  for (const b of rows) {
    const amount = b.cardPart + b.walletPart;
    if (amount <= 0) continue;

    if (!b.customerId) {
      await tx.insert(walletDecisions).values({
        kind: "no-customer",
        bookingId: b.id,
        paymentId: b.paymentId,
        amountHalalas: amount,
        detail: { reason },
      });
      continue;
    }
    if (!b.customerEmail) throw new WalletHeld(`booking ${b.id} has no email (open question 6)`);

    await tx.execute(sql`select 1 from ${customers} where ${customers.id} = ${b.customerId} for update`);
    const [row] = await tx
      .insert(walletTxns)
      .values({
        customerId: b.customerId,
        ownerEmail: b.customerEmail,
        deltaHalalas: amount,
        reason,
        bookingId: b.id,
        paymentId: b.paymentId,
        note,
      })
      .onConflictDoNothing()
      .returning({ id: walletTxns.id });
    if (row) credited += amount;
  }
  return credited;
}
