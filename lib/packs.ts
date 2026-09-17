// Membership packs — the database side (docs/SCOPE-ENHANCEMENT.md §6).
//
// A bundle of services bought at one price and spent over three months. The
// client's word is "membership", but nothing recurs: it is prepaid credit, and
// redemption is wallet-shaped. Nothing to present at the desk, no barcode — she
// books, and one credit comes off.
//
// The same split as lib/loyalty.ts and lib/promo.ts: this file is the lookups
// and the ledger writes, so what a screen shows and what a booking spends come
// from one set of functions. There is no stored balance anywhere — see the note
// on customer_packs in lib/db/schema.ts.
//
// Credits are per service and not interchangeable: three gel polishes and one
// manicure cannot become four gel polishes. So every balance here is a balance
// *of a service*, never of a pack.

import "server-only";
import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customerPacks, packTxns, packs, packServices, services } from "@/lib/db/schema";
import type { Localized } from "@/lib/db/schema";
import { getSettings } from "@/lib/settings";

/** One ledger row, reduced to what the liveness rule below needs. */
export type PackLedgerRow = {
  delta: number;
  /**
   * "purchase" for the grant, "booking" for a spend, "return:<why>" for a credit
   * handed back, else an adjustment somebody wrote by hand.
   */
  reason?: string | null;
  /** Null when the movement belongs to no booking — a purchase, or a return. */
  bookingStatus: string | null;
  bookingCancelReason: string | null;
  bookingCreatedAt: Date | null;
};

/**
 * A `-1` that was never actually redeemed, and must not be counted.
 *
 * The credit comes off when the booking is *created*, which is before she has
 * paid for anything — the chair is only being held. Two ways that hold can end
 * with nobody served and nobody charged, and in neither does anything give the
 * credit back:
 *
 *   • the hold was collected by sweepExpiredHolds — `cancelled` with
 *     `payment-timeout` on it, the card declined or the tab closed;
 *   • it is *still* pending past the window it had to be paid in, because the
 *     sweep only runs when some other customer happens to book at that branch.
 *
 * The second clause is the one that is easy to miss, and lib/rewards.ts warns
 * about it in the same words: never make the balance depend on the sweep having
 * run. A retry inside the window keeps its debit — same booking, same row —
 * which is correct, not a leak.
 *
 * **Deliberately narrower than isDead() next door.** A customer cancellation or
 * a no-show does *not* strand a credit here, because packs already answer both:
 * returnPackCredits gives it back inside `cancel_cutoff_hours` and keeps it
 * outside, exactly as the money is kept. Treating every `cancelled` row as dead
 * would return the credit a second time on top of that `+1`, and would quietly
 * delete the late-cancellation rule along the way.
 */
function neverRedeemed(row: PackLedgerRow, holdMin: number, now: Date): boolean {
  const { bookingStatus: status, bookingCreatedAt: createdAt } = row;

  // A movement whose booking is gone — in either direction.
  //
  // `pack_txns.booking_id` is `on delete set null`, so a deleted booking leaves
  // its rows pointing at nothing. Nobody was served, so the `-1` and the `+1`
  // that reversed it both stop meaning anything, and they have to go together:
  // dropping only the debit left the return standing alone as a credit she was
  // never sold. `reason` is the discriminator — a purchase grant and a manual
  // adjustment carry neither mark, and keep counting, which is right.
  //
  // deleteBooking already refuses a booking that touched a credit, so only a raw
  // delete makes one of these. That guard is the first defence; this is the rule
  // that does not depend on it staying.
  if (status === null) return row.reason === "booking" || !!row.reason?.startsWith("return:");
  if (status === "cancelled") return row.bookingCancelReason === "payment-timeout";
  if (status !== "pending") return false;
  // No created_at shouldn't happen. Treated as stranded rather than spent: the
  // failure mode of guessing wrong is a customer who cannot spend a credit she
  // paid for, and that is the worse of the two.
  if (!createdAt) return true;
  return now.getTime() - createdAt.getTime() > holdMin * 60_000;
}

/**
 * SUM(delta) over rows that still count. **This is the whole rule and the only
 * copy of it** — packCredits and spendPackCredit both read their rows and hand
 * them straight here, so the balance a screen shows and the balance a booking
 * spends against can never disagree.
 */
export function spendableCredits(
  rows: PackLedgerRow[],
  holdMin: number,
  now: Date = new Date(),
): number {
  return rows.reduce((sum, r) => (neverRedeemed(r, holdMin, now) ? sum : sum + r.delta), 0);
}

/** One line of what a customer has left, for a screen or a booking. */
export type PackCredit = {
  customerPackId: string;
  packName: Localized;
  serviceId: string;
  serviceName: Localized | null;
  /** Credits still on it. Always > 0 — spent lines are not credits. */
  left: number;
  /**
   * What the membership came with for this service, so a screen can say "2 of 8
   * used" rather than only "6 left".
   *
   * The purchase grant alone, which is the snapshot buyPack wrote — not the sum
   * of every positive row. A credit handed back by returnPackCredits is also a
   * `+1`, and counting it here would grow what she was sold every time she
   * cancelled something in time.
   */
  granted: number;
  expiresAt: Date;
};

/**
 * The db, or a transaction handle from inside createBookings.
 *
 * `execute` is in there for the row lock in spendPackCredit; both the pool and a
 * transaction handle satisfy this, which is what lets the check scripts call it
 * directly while the booking engine passes its own `tx`.
 */
type Spender = Pick<typeof db, "insert" | "select" | "execute">;

/**
 * Everything this customer can still spend, newest deadline last.
 *
 * Expiry is applied here rather than at midnight by a job: a credit is dead the
 * moment its deadline passes, and a row nobody swept is not a credit the salon
 * owes. The same reason lib/refill.ts decides its window on read.
 */
export async function packCredits(customerId: string, now = new Date()): Promise<PackCredit[]> {
  const owned = await db
    .select()
    .from(customerPacks)
    .where(and(eq(customerPacks.customerId, customerId), gt(customerPacks.expiresAt, now)));

  if (owned.length === 0) return [];

  const { booking_hold_min: holdMin } = await getSettings(["booking_hold_min"]);

  // Left-joined onto the booking each movement belongs to, because a `-1` alone
  // does not say whether anybody was ever served for it. See neverRedeemed.
  const rows = await db
    .select({
      customerPackId: packTxns.customerPackId,
      serviceId: packTxns.serviceId,
      delta: packTxns.delta,
      reason: packTxns.reason,
      serviceName: services.name,
      bookingStatus: bookings.status,
      bookingCancelReason: bookings.cancelReason,
      bookingCreatedAt: bookings.createdAt,
    })
    .from(packTxns)
    .leftJoin(services, eq(services.id, packTxns.serviceId))
    .leftJoin(bookings, eq(bookings.id, packTxns.bookingId))
    .where(
      inArray(
        packTxns.customerPackId,
        owned.map((p) => p.id),
      ),
    );

  // Grouped per (purchase, service) and summed in TypeScript rather than SQL,
  // for the reason loyaltyBalance gives: one customer's ledger is small, and a
  // rule written twice is a rule that drifts.
  const totals = new Map<string, PackCredit & { rows: PackLedgerRow[] }>();
  for (const row of rows) {
    const key = `${row.customerPackId}:${row.serviceId}`;
    const pack = owned.find((p) => p.id === row.customerPackId)!;
    const at = totals.get(key) ?? {
      customerPackId: row.customerPackId,
      packName: pack.name,
      serviceId: row.serviceId,
      serviceName: row.serviceName ?? null,
      left: 0,
      granted: 0,
      expiresAt: pack.expiresAt,
      rows: [],
    };
    at.rows.push(row);
    totals.set(key, at);
  }

  return [...totals.values()]
    .map(({ rows: ledger, ...credit }) => ({
      ...credit,
      left: spendableCredits(ledger, holdMin, now),
      granted: ledger.reduce((sum, r) => (r.reason === "purchase" ? sum + r.delta : sum), 0),
    }))
    .filter((c) => c.left > 0)
    .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
}

export type PackQuote =
  | { ok: true; customerPackId: string; serviceId: string; left: number }
  /**
   * Not hers, expired, or nothing left for this service — one answer, because
   * one is all anybody asks for. The booking screen only ever offers credits she
   * actually holds, so a refusal here is a request nobody's screen produced.
   * Give it a reason when a screen exists that says a different sentence for
   * each.
   */
  | { ok: false };

/**
 * May this customer spend a credit from this purchase, on this service?
 *
 * Called twice for one checkout, exactly as quoteReward is: once to show her the
 * credit, and again inside createBookings to decide what she is charged. The
 * second is the authority, and running the identical function both times is what
 * keeps the two answers the same.
 */
export async function quotePackCredit(
  customerId: string,
  customerPackId: string,
  serviceId: string,
  now = new Date(),
): Promise<PackQuote> {
  // packCredits already answers all of it: it reads only her own purchases,
  // drops the expired ones, and keeps only services with something left. A line
  // coming back is a credit she can spend, and no line is a refusal.
  const credits = await packCredits(customerId, now);
  const line = credits.find(
    (c) => c.customerPackId === customerPackId && c.serviceId === serviceId,
  );

  return line ? { ok: true, customerPackId, serviceId, left: line.left } : { ok: false };
}

/**
 * Spend one credit on a booking. False when there was nothing left to spend.
 *
 * Call inside the booking transaction. A booking that fails must not spend a
 * credit, and the partial unique index on (booking_id, service_id) is what stops
 * a retried request spending a second one — the same shape of guard as the
 * refill index, and for the same reason: a check before the write can be raced.
 *
 * That index is keyed on the booking, though, so it only ever sees one booking's
 * worth of the story. Two tabs making two *different* bookings against the same
 * purchase walk straight past it, and quotePackCredit cannot help: it read the
 * ledger before either had written to it, so both were told yes. She bought one
 * credit and spent two.
 *
 * So the purchase row is locked first and the balance recounted underneath it.
 * The lock is what makes the count mean something — the second caller waits for
 * the first to commit, then counts, then finds nothing and says so. Locking the
 * purchase rather than the ledger because it is the row that exists exactly once
 * per purchase; the ledger lines are what we are trying to count.
 */
export async function spendPackCredit(
  tx: Spender,
  customerPackId: string,
  serviceId: string,
  bookingId: string,
  now = new Date(),
): Promise<boolean> {
  // Serialises every spend against this purchase. Held to the end of the
  // booking transaction, which is short and touches one customer's own row.
  await tx.execute(sql`select 1 from customer_packs where id = ${customerPackId} for update`);

  const [owner] = await tx
    .select({ expiresAt: customerPacks.expiresAt })
    .from(customerPacks)
    .where(eq(customerPacks.id, customerPackId))
    .limit(1);
  if (!owner || owner.expiresAt <= now) return false;

  // The balance, recounted now that nobody else can be mid-spend. Same SUM the
  // quote did, through the same spendableCredits — it is just finally being read
  // at a moment when the answer cannot change underneath it. Counting it by a
  // different rule than packCredits would be the whole bug back: a credit the
  // booking screen offers and this refuses.
  const { booking_hold_min: holdMin } = await getSettings(["booking_hold_min"]);
  const ledger = await tx
    .select({
      delta: packTxns.delta,
      reason: packTxns.reason,
      bookingStatus: bookings.status,
      bookingCancelReason: bookings.cancelReason,
      bookingCreatedAt: bookings.createdAt,
    })
    .from(packTxns)
    .leftJoin(bookings, eq(bookings.id, packTxns.bookingId))
    .where(
      and(eq(packTxns.customerPackId, customerPackId), eq(packTxns.serviceId, serviceId)),
    );
  if (spendableCredits(ledger, holdMin, now) <= 0) return false;

  await tx.insert(packTxns).values({
    customerPackId,
    serviceId,
    bookingId,
    delta: -1,
    reason: "booking",
  });
  return true;
}

/**
 * Give a credit back, for a booking that was cancelled in time.
 *
 * From the customer's own cancel route this sits beside refundBookings, inside
 * the same `cancel_cutoff_hours` window that governs money: cancel late and the
 * credit is spent, exactly as the fee is kept.
 *
 * The desk's cancellation calls it unconditionally, and that is not a hole in
 * the rule. The window exists because cancelling late is *her* choice; a
 * technician off sick is not, and she should not lose an appointment she paid
 * for over a decision that was never hers.
 *
 * **Idempotent by index, not by inspection.** `pack_txns_return_unique` refuses
 * the second `+1` for a booking and service. Reading the ledger first and
 * looking for an existing return was a check before a write, and two
 * receptionists on one appointment raced straight past it.
 */
export async function returnPackCredits(bookingIds: string[], reason: string): Promise<number> {
  if (bookingIds.length === 0) return 0;

  const spent = await db
    .select()
    .from(packTxns)
    .where(and(inArray(packTxns.bookingId, bookingIds), lt(packTxns.delta, 0)));

  if (spent.length === 0) return 0;

  // Whatever the index let through is what actually came back, which is what
  // the caller is told. A row already returned conflicts and is skipped, so
  // calling this twice is not an error — it is simply a second no-op.
  const back = await db
    .insert(packTxns)
    .values(
      spent.map((row) => ({
        customerPackId: row.customerPackId,
        serviceId: row.serviceId,
        bookingId: row.bookingId,
        delta: 1,
        // Marked here, not by the caller: a new way to end a booking cannot
        // invent a reason the orphan rule above fails to recognise. The caller's
        // word survives in the log — "return:salon-cancelled".
        reason: `return:${reason}`,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: packTxns.id });

  return back.length;
}

/**
 * Buy a pack: the purchase row, and the grant that is its lines.
 *
 * The grant is written as ledger rows — one `+quantity` per service — rather
 * than copied into a table of its own. That is what snapshots the purchase: a
 * pack whose contents the salon edits next week does not change what she has
 * left, because what she has left was never read from the pack.
 */
export async function buyPack(
  customerId: string,
  packId: string,
  now = new Date(),
): Promise<{ ok: true; customerPackId: string } | { ok: false; reason: "not-found" | "empty" }> {
  const [pack] = await db
    .select()
    .from(packs)
    .where(and(eq(packs.id, packId), eq(packs.active, true)))
    .limit(1);
  if (!pack) return { ok: false, reason: "not-found" };

  const lines = await db.select().from(packServices).where(eq(packServices.packId, packId));
  // A pack with nothing in it is not a thing anyone can be sold.
  if (lines.length === 0) return { ok: false, reason: "empty" };

  const expiresAt = new Date(now.getTime() + pack.validDays * 86_400_000);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(customerPacks)
      .values({
        customerId,
        packId: pack.id,
        name: pack.name,
        priceHalalas: pack.priceHalalas,
        purchasedAt: now,
        expiresAt,
      })
      .returning({ id: customerPacks.id });

    await tx.insert(packTxns).values(
      lines.map((line) => ({
        customerPackId: row.id,
        serviceId: line.serviceId,
        delta: line.quantity,
        reason: "purchase",
      })),
    );

    return { ok: true as const, customerPackId: row.id };
  });
}
