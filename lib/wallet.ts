// The wallet: money a customer holds with the salon (docs/WALLET-PLAN.md).
//
// A ledger, wallet_txns, with no balance column. A wallet is an email: its
// balance is SUM(delta) over the rows of that email, whichever customer row
// each was written on. Credit belongs to the email of the booking or gift card
// it came from, and only a sign-in with that email reaches it: an account
// holder who booked signed out has credit on a guest row with her address.
//
// Every write is one row, and every repeat of a write is refused by a unique
// index on that table rather than by a read before it.

import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
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
  ownerEmail: string,
  executor: Pick<typeof db, "select"> = db,
): Promise<{ total: number; available: number }> {
  const [row] = await executor
    .select({ total: sql<number>`coalesce(sum(${walletTxns.deltaHalalas}), 0)::int` })
    .from(walletTxns)
    .where(eq(walletTxns.ownerEmail, ownerEmail.trim().toLowerCase()));
  return { total: row.total, available: Math.max(0, row.total) };
}

/** Serialise every write that reads a wallet's balance. Held to the end of `tx`. */
async function lockWallet(tx: Tx, ownerEmail: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"wallet:" + ownerEmail}))`);
}

/**
 * The only way to spend. Locks the wallet (its email, not a customer row: one
 * email can book as an account and as a guest) and reads the balance inside
 * the lock, so two checkouts cannot both spend one balance: the second waits
 * here and sees the first's spend.
 *
 * `customerId` is the row the checkout books as, recorded on the spend.
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
  const email = ownerEmail.trim().toLowerCase();
  await lockWallet(tx, email);

  if ((await walletBalance(email, tx)).available < halalas) return null;

  const [row] = await tx
    .insert(walletTxns)
    .values({
      customerId,
      ownerEmail: email,
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

    await lockWallet(tx, b.customerEmail);
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

/**
 * Take back credit whose payment went back to her card after all: a refund
 * from StreamPay's dashboard, or a chargeback found by the daily comparison.
 * Called from refundedOutside with every payment row of the one StreamPay
 * payment and StreamPay's **running** refunded total for it.
 *
 * Worked out per payment, never per booking: a group's one payment funds a
 * credit per guest, and a sum per credit would take the refund back once per
 * guest. Only the card-paid part of those credits can be taken; what her
 * wallet paid was never on that card. What is due is that part, capped by
 * the running total, less what earlier calls already took, so a repeat of the
 * same total writes nothing.
 *
 * It can leave her below zero when she already spent the credit. She is shown
 * zero, and the owner is sent the case (wallet_decisions). Returns what it took.
 */
export async function reverseCredit(
  tx: Tx,
  paymentIds: string[],
  refundedSoFarHalalas: number,
): Promise<{ tookHalalas: number; owedHalalas: number }> {
  const none = { tookHalalas: 0, owedHalalas: 0 };
  if (paymentIds.length === 0 || refundedSoFarHalalas <= 0) return none;

  const credits = await tx
    .select({
      customerId: walletTxns.customerId,
      ownerEmail: walletTxns.ownerEmail,
      deltaHalalas: walletTxns.deltaHalalas,
      paymentId: walletTxns.paymentId,
      cardHalalas: payments.amountHalalas,
    })
    .from(walletTxns)
    .innerJoin(payments, eq(payments.id, walletTxns.paymentId))
    .where(
      and(
        inArray(walletTxns.paymentId, paymentIds),
        inArray(walletTxns.reason, ["cancel-customer", "cancel-salon", "chair-credit"]),
      ),
    );
  if (credits.length === 0) return none;

  // One payment is one bill, booked under one email.
  const [first] = credits;
  await lockWallet(tx, first.ownerEmail);

  const cardPart = credits.reduce((sum, c) => sum + Math.min(c.deltaHalalas, c.cardHalalas), 0);
  const [{ taken }] = await tx
    .select({ taken: sql<number>`coalesce(-sum(${walletTxns.deltaHalalas}), 0)::int` })
    .from(walletTxns)
    .where(and(eq(walletTxns.reason, "reversal"), inArray(walletTxns.paymentId, paymentIds)));
  const due = Math.min(refundedSoFarHalalas, cardPart) - taken;
  if (due <= 0) return none;

  await tx.insert(walletTxns).values({
    customerId: first.customerId,
    ownerEmail: first.ownerEmail,
    deltaHalalas: -due,
    reason: "reversal",
    paymentId: first.paymentId,
  });

  const { total } = await walletBalance(first.ownerEmail, tx);
  if (total < 0) {
    await tx.insert(walletDecisions).values({
      kind: "negative-balance",
      customerId: first.customerId,
      paymentId: first.paymentId,
      amountHalalas: -total,
      detail: { ownerEmail: first.ownerEmail, reversedHalalas: due },
    });
  }
  return { tookHalalas: due, owedHalalas: Math.max(0, -total) };
}

/**
 * The customer row a wallet's email belongs to, when a row has to be named: the
 * account with that email, else the guest row. Undefined when nobody has it.
 */
export async function walletOwner(email: string, executor: Pick<typeof db, "select"> = db) {
  const [owner] = await executor
    .select()
    .from(customers)
    .where(sql`lower(${customers.email}) = ${email.trim().toLowerCase()}`)
    .orderBy(desc(sql`${customers.emailVerifiedAt} is not null`))
    .limit(1);
  return owner;
}

/**
 * The owner's correction: `halalas` in (+) or out (−) of the wallet of
 * `ownerEmail`, with the reason she gave, on walletOwner's row. Null when no
 * customer has the email: there is no wallet to correct. Call from the one
 * owner-only action, which audits it.
 */
export async function correctWallet(
  tx: Tx,
  c: { ownerEmail: string; halalas: number; note: string; actorId: string | null },
): Promise<string | null> {
  const email = c.ownerEmail.trim().toLowerCase();
  const owner = await walletOwner(email, tx);
  if (!owner) return null;

  await lockWallet(tx, email);
  const [row] = await tx
    .insert(walletTxns)
    .values({
      customerId: owner.id,
      ownerEmail: email,
      deltaHalalas: c.halalas,
      reason: "correction",
      note: c.note,
      actorId: c.actorId,
    })
    .returning({ id: walletTxns.id });
  return row.id;
}

/**
 * A chair purchase of CHAIR_CREDIT_MAX_HALALAS or less that could not be
 * delivered: credit to the visit's email instead of a card refund (CLAUDE.md).
 * Call in the transaction that marks the payment `owedCredit`. One per payment
 * (wallet_txns_chair_unique). False when the visit has no customer or no email:
 * the payment stays marked, as before the wallet, for the owner to settle.
 */
export async function creditChair(tx: Tx, paymentId: string, bookingId: string, halalas: number): Promise<boolean> {
  const [visit] = await tx
    .select({ customerId: bookings.customerId, customerEmail: bookings.customerEmail })
    .from(bookings)
    .where(eq(bookings.id, bookingId));
  if (!visit?.customerId || !visit.customerEmail) return false;

  await lockWallet(tx, visit.customerEmail);
  const [row] = await tx
    .insert(walletTxns)
    .values({
      customerId: visit.customerId,
      ownerEmail: visit.customerEmail,
      deltaHalalas: halalas,
      reason: "chair-credit",
      bookingId,
      paymentId,
    })
    .onConflictDoNothing()
    .returning({ id: walletTxns.id });
  return Boolean(row);
}
