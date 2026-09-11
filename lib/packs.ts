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
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerPacks, packTxns, packs, packServices, services } from "@/lib/db/schema";
import type { Localized } from "@/lib/db/schema";

/** One line of what a customer has left, for a screen or a booking. */
export type PackCredit = {
  customerPackId: string;
  packName: Localized;
  serviceId: string;
  serviceName: Localized | null;
  /** Credits still on it. Always > 0 — spent lines are not credits. */
  left: number;
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

  const rows = await db
    .select({
      customerPackId: packTxns.customerPackId,
      serviceId: packTxns.serviceId,
      delta: packTxns.delta,
      serviceName: services.name,
    })
    .from(packTxns)
    .leftJoin(services, eq(services.id, packTxns.serviceId))
    .where(
      inArray(
        packTxns.customerPackId,
        owned.map((p) => p.id),
      ),
    );

  // SUM(delta) per (purchase, service), in TypeScript rather than SQL for the
  // reason loyaltyBalance gives: one customer's ledger is small, and a rule
  // written twice is a rule that drifts.
  const totals = new Map<string, PackCredit>();
  for (const row of rows) {
    const key = `${row.customerPackId}:${row.serviceId}`;
    const pack = owned.find((p) => p.id === row.customerPackId)!;
    const at = totals.get(key) ?? {
      customerPackId: row.customerPackId,
      packName: pack.name,
      serviceId: row.serviceId,
      serviceName: row.serviceName ?? null,
      left: 0,
      expiresAt: pack.expiresAt,
    };
    at.left += row.delta;
    totals.set(key, at);
  }

  return [...totals.values()]
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
  // quote did, and the same rule — it is just finally being read at a moment
  // when the answer cannot change underneath it.
  const ledger = await tx
    .select({ delta: packTxns.delta })
    .from(packTxns)
    .where(
      and(eq(packTxns.customerPackId, customerPackId), eq(packTxns.serviceId, serviceId)),
    );
  if (ledger.reduce((sum, r) => sum + r.delta, 0) <= 0) return false;

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
 * Called where refundBookings is: inside the same `cancel_cutoff_hours` window
 * that governs money. Cancel late and the credit is spent, exactly as money
 * would be — that symmetry is the whole rule, and it is why this is not called
 * from the cancel path unconditionally.
 *
 * Idempotent by inspection rather than by index: returning twice would be a
 * second `+1`, and the ledger cannot tell those apart on its own.
 */
export async function returnPackCredits(bookingIds: string[], reason: string): Promise<number> {
  if (bookingIds.length === 0) return 0;

  const spent = await db
    .select()
    .from(packTxns)
    .where(and(inArray(packTxns.bookingId, bookingIds)));

  // One return per spend. Two cancellations of one booking must not mint a
  // credit the customer never bought.
  const key = (r: (typeof spent)[number]) => `${r.bookingId}:${r.serviceId}`;
  const alreadyBack = new Set(spent.filter((r) => r.delta > 0).map(key));
  const given = spent.filter((r) => r.delta < 0 && !alreadyBack.has(key(r)));

  if (given.length === 0) return 0;

  await db.insert(packTxns).values(
    given.map((row) => ({
      customerPackId: row.customerPackId,
      serviceId: row.serviceId,
      bookingId: row.bookingId,
      delta: 1,
      reason,
    })),
  );

  return given.length;
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
