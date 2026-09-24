import "server-only";

// Selling something that is not a booking: a gift card, a membership pack, a
// treat for the chair she is sitting in.
//
// Same two halves as confirm.ts, and the same reason: the gateway's answer
// arrives later, on the return page or by webhook. What she is buying is
// written onto the pending `payments` row *before* any money moves
// (`raw.intent`), and delivered only once the payment is verified. That closes
// the hole the old charge-then-grant order had — a process dying between the
// two left her charged with nothing and only a log line to show for it.
//
// If delivery fails after the money has moved, the money goes straight back.

import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db";
import { bookingAddons, bookings, giftCards, payments } from "@/lib/db/schema";
import { reserveStations } from "@/lib/availability";
import { withLapsedHoldsReleased } from "@/lib/bookings";
import { issueGiftCard } from "@/lib/giftcards";
import { sendGiftCardEmails } from "@/lib/giftcard/email";
import { buyPack } from "@/lib/packs";
import { sendMembershipEmail } from "@/lib/membership-email";
import { sendVisitEmail } from "@/lib/visit-email";
import { siteOrigin } from "@/lib/site";
import { afterResponse } from "@/lib/after-response";
import { emailCreditOwed, refundRef } from "./refund";
import { checkoutOf, getDriver, mergeRaw, PAY_WINDOW_MIN, type Checkout, type Line, type Payer, type Verdict } from "./index";

export type GiftIntent = {
  kind: "gift_card";
  amountSar: number;
  designId: string | null;
  buyerName: string | null;
  buyerEmail: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  message: string | null;
  lang: "ar" | "en";
  /**
   * Scopes "resume the checkout already open for this purchase" to one buyer.
   * Without it two strangers buying the same card for "Mom" within the pay
   * window matched each other's intent and shared one checkout — and its code.
   */
  attemptId?: string;
};
export type PackIntent = { kind: "pack"; customerId: string; packId: string };
/**
 * Things bought from the chair for the visit in progress (lib/station-treat.ts):
 * treats, and service add-ons when the chair is free long enough after her.
 * `durationMin` is 0 for a treat; the rest is added to the booking's end.
 */
export type TreatItem = { addonId: string; name: { ar: string; en: string }; priceHalalas: number; durationMin: number };
export type TreatIntent = {
  kind: "treat";
  bookingId: string;
  items: TreatItem[];
};
export type Intent = GiftIntent | PackIntent | TreatIntent;

/**
 * How long a claimed-but-not-yet-delivered purchase still reads as pending to a
 * second caller. Delivery is a few inserts and an email; this is generous.
 */
const DELIVERY_GRACE_MS = 2 * 60_000;

/** What the page shows once it is paid for. */
export type Delivered =
  | { kind: "gift_card"; code: string }
  | { kind: "pack"; customerPackId: string }
  | { kind: "treat"; names: { ar: string; en: string }[] };

export type PurchaseResult =
  | { ok: true; delivered: Delivered }
  | { ok: true; checkout: Checkout }
  | {
      ok: false;
      /**
       * `not-delivered`: paid, and then it could not be handed over — a treat a
       * second tap already added, a pack withdrawn mid-checkout. The money has
       * been sent back (or the log says REFUND OWED); a retry is a new purchase.
       */
      error: "payment-declined" | "failed" | "not-delivered" | "not-found" | "unverified";
    };

export async function startPurchase(input: {
  intent: Intent;
  amountHalalas: number;
  lines: Line[];
  title: string;
  payer: Payer;
  /** The page to come back to after a full-window checkout. */
  back: string;
  /** Who asked, for the gift card limit (app/api/gift-cards). */
  ip?: string;
  simulate?: "decline";
}): Promise<PurchaseResult> {
  // The same purchase already has a live checkout: Pay pressed again, a reload,
  // Back. Resumed, not doubled — a second link is a second way to pay for one
  // thing. Paid meanwhile, it is delivered and shown; only one that is over
  // falls through to a fresh checkout.
  // ponytail: two taps in the same instant can still both miss this and make two
  // links; the page only ever shows the last, so the other is never payable in practice.
  const [open] = await db
    .select({ ref: payments.providerRef })
    .from(payments)
    .where(
      and(
        eq(payments.status, "pending"),
        isNull(payments.bookingId),
        gt(payments.createdAt, new Date(Date.now() - PAY_WINDOW_MIN * 60_000)),
        sql`${payments.raw} ->> 'linkId' is not null`,
        sql`${payments.raw} -> 'intent' = ${JSON.stringify(input.intent)}::jsonb`,
      ),
    )
    .orderBy(desc(payments.createdAt))
    .limit(1);
  if (open?.ref) {
    const outcome = await settlePurchase(open.ref);
    if (outcome.ok || outcome.error !== "payment-declined") return outcome;
  }

  const driver = getDriver();
  const ref = randomUUID();

  await db.insert(payments).values({
    provider: driver.name,
    providerRef: ref,
    method: "card",
    amountHalalas: input.amountHalalas,
    status: "pending",
    raw: { intent: input.intent, ...(input.ip ? { ip: input.ip } : {}) },
  });

  let charge;
  try {
    charge = await driver.charge({
      ref,
      amountHalalas: input.amountHalalas,
      lines: input.lines,
      discounts: [],
      title: input.title,
      payer: input.payer,
      expiresAt: new Date(Date.now() + PAY_WINDOW_MIN * 60_000),
      returnUrl: `${siteOrigin()}/api/payments/return?ref=${ref}&back=${encodeURIComponent(input.back)}`,
      simulate: input.simulate,
    });
  } catch (err) {
    console.error(`[purchase] ${input.intent.kind} charge threw`, err);
    await markFailed(ref);
    return { ok: false, error: "failed" };
  }

  if (charge.status === "pending") {
    await saveCheckout(ref, charge.raw);
    return { ok: true, checkout: checkoutOf(ref, charge.raw) ?? { ref, url: charge.checkoutUrl } };
  }
  if (charge.status !== "paid") {
    await markFailed(ref);
    return { ok: false, error: "payment-declined" };
  }
  return settlePurchase(ref, {
    status: "paid",
    amountHalalas: input.amountHalalas,
    method: "card",
    raw: (charge.raw ?? {}) as Record<string, unknown>,
  });
}

/**
 * Deliver what `ref` paid for, once and only once. Idempotent and safe to race,
 * like settleBookingPayment: the pending → paid claim decides who delivers.
 */
export async function settlePurchase(ref: string, known?: Verdict): Promise<PurchaseResult> {
  const [row] = await db.select().from(payments).where(eq(payments.providerRef, ref)).limit(1);
  const intent = (row?.raw as { intent?: Intent } | null)?.intent;
  if (!row || !intent) return { ok: false, error: "not-found" };

  if (row.status === "paid") {
    const delivered = await deliveredOf(row, intent);
    if (delivered) return { ok: true, delivered };
    // Claimed a moment ago and still being handed over by whoever claimed it —
    // the return page and the status poll routinely arrive together. Telling
    // this caller "not delivered" would show her a failure for a purchase that
    // lands a second later, so it is still pending. Past the grace it is real,
    // and lib/payments/reconcile.ts refunds it.
    const checkout = checkoutOf(ref, row.raw);
    if (checkout && Date.now() - row.updatedAt.getTime() < DELIVERY_GRACE_MS) {
      return { ok: true, checkout };
    }
    return { ok: false, error: "not-delivered" };
  }
  if (row.status === "refunded") return { ok: false, error: "not-delivered" };
  if (row.status === "failed") return { ok: false, error: "payment-declined" };

  const driver = getDriver();
  let verdict: Verdict;
  try {
    verdict = known ?? (await driver.verify(row.raw));
  } catch (err) {
    console.error(`[purchase] could not verify ${ref}`, err);
    return { ok: false, error: "unverified" };
  }

  if (verdict.status === "pending") {
    const checkout = checkoutOf(ref, row.raw);
    return checkout ? { ok: true, checkout } : { ok: false, error: "failed" };
  }
  if (verdict.status === "failed") {
    await markFailed(ref);
    await driver.cancel(row.raw);
    return { ok: false, error: "payment-declined" };
  }

  const claimed = await db
    .update(payments)
    .set({
      status: "paid",
      method: verdict.method,
      raw: mergeRaw(payments.raw, verdict.raw),
      updatedAt: new Date(),
    })
    .where(and(eq(payments.id, row.id), eq(payments.status, "pending")))
    .returning({ id: payments.id });
  if (claimed.length === 0) return settlePurchase(ref);

  // A process dying between the claim above and the delivery below leaves a
  // paid row with nothing delivered; lib/payments/reconcile.ts refunds it.
  if (verdict.amountHalalas !== row.amountHalalas) {
    // Not the price we asked for, so "refund it" has no right number. A person's
    // job: marked so the reconciler leaves it alone and the daily report names it.
    await db
      .update(payments)
      .set({ raw: mergeRaw(payments.raw, { amountMismatch: verdict.amountHalalas }) })
      .where(eq(payments.id, row.id));
    console.error(
      `[purchase] ${ref} paid ${verdict.amountHalalas} for ${row.amountHalalas}; not delivered. REFUND OWED — settle by hand`,
    );
    return { ok: false, error: "not-delivered" };
  }

  const delivered = await deliverOnce(row.id, intent, row.amountHalalas, paidLate(row));

  if (!delivered) {
    const back = row.amountHalalas > 0 ? await refundOrCredit(ref, row.amountHalalas, intent) : true;
    console.error(`[purchase] ${ref}: ${back ? "refunded or owed as credit" : "REFUND OWED — settle by hand"}`);
    return { ok: false, error: "not-delivered" };
  }
  return { ok: true, delivered };
}

/**
 * A chair purchase this small is not worth a card refund: the card fees and a
 * 5-14 day wait cost more than a coffee. It goes to her wallet instead.
 */
export const CHAIR_CREDIT_MAX_HALALAS = 1000;

/**
 * Give back a paid purchase that could not be delivered: to her card, or —
 * a chair purchase of CHAIR_CREDIT_MAX_HALALAS or less — as wallet credit.
 * True when it is settled one way or the other.
 */
export async function refundOrCredit(ref: string, amountHalalas: number, intent: Intent): Promise<boolean> {
  if (intent.kind === "treat" && amountHalalas <= CHAIR_CREDIT_MAX_HALALAS) {
    // ponytail: the wallet is its own PR. Until it ships, the credit is marked
    // here, she is told to ask the desk, and the daily report lists it until
    // the wallet turns it into real credit. Marked once, so she is told once.
    const [marked] = await db
      .update(payments)
      .set({ raw: mergeRaw(payments.raw, { owedCredit: amountHalalas }) })
      .where(and(eq(payments.providerRef, ref), sql`not (${payments.raw} ? 'owedCredit')`))
      .returning({ raw: payments.raw, bookingId: payments.bookingId, treatBookingId: payments.treatBookingId });
    if (marked) await emailCreditOwed(marked, amountHalalas);
    return true;
  }
  return (await refundRef(ref, "not-delivered")).ok;
}

/**
 * Deliver a paid purchase again, for the settle job: the process that should
 * have delivered it died first. Almost always works, which beats refunding her
 * and making her buy it again. True when it is delivered.
 */
export async function redeliver(ref: string): Promise<boolean> {
  const [row] = await db.select().from(payments).where(eq(payments.providerRef, ref)).limit(1);
  const intent = (row?.raw as { intent?: Intent } | null)?.intent;
  if (!row || row.status !== "paid" || !intent) return false;
  return (await deliverOnce(row.id, intent, row.amountHalalas, true)) !== null;
}

/**
 * deliver, with the row as the final word. The grant and its link to the
 * payment commit together, so the row says whether it was handed over: a step
 * after them (an email) may be what threw, or a second delivery racing this one
 * won and this one was rolled back. Either way she has it, and nothing is refunded.
 */
async function deliverOnce(paymentId: string, intent: Intent, amountHalalas: number, late: boolean): Promise<Delivered | null> {
  try {
    const delivered = await deliver(paymentId, intent, amountHalalas, late);
    if (delivered) return delivered;
  } catch (err) {
    console.error(`[purchase] payment ${paymentId} (${intent.kind}) paid but not delivered`, err);
  }
  const [fresh] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  return fresh ? deliveredOf(fresh, intent) : null;
}

/** Settled after its pay window: StreamPay was down, the bank held it, or the job found it. */
const paidLate = (row: { createdAt: Date }) => Date.now() - row.createdAt.getTime() > PAY_WINDOW_MIN * 60_000;

async function deliver(paymentId: string, intent: Intent, amountHalalas: number, late: boolean): Promise<Delivered | null> {
  if (intent.kind === "gift_card") {
    const card = await issueGiftCard({
      paymentId,
      amountHalalas,
      designId: intent.designId,
      buyerName: intent.buyerName,
      buyerEmail: intent.buyerEmail,
      recipientName: intent.recipientName,
      recipientEmail: intent.recipientEmail,
      message: intent.message,
      expiresInMonths: 12,
    });
    if (!card.ok) return null;

    // The emails: the card to the recipient's address, if she gave one, and
    // the buyer's receipt. The WhatsApp share is the buyer's own, on the
    // success screen. Neither can fail the sale.
    await afterResponse(`gift card emails for ${paymentId}`, () => sendGiftCardEmails({
      code: card.code,
      amountSar: intent.amountSar,
      senderName: intent.buyerName,
      recipientName: intent.recipientName,
      recipientEmail: intent.recipientEmail,
      buyerEmail: intent.buyerEmail,
      message: intent.message,
      expiresAt: card.expiresAt,
      lang: intent.lang,
    }));
    return { kind: "gift_card", code: card.code };
  }

  if (intent.kind === "pack") {
    const bought = await buyPack(intent.customerId, intent.packId, new Date(), paymentId);
    if (!bought.ok) return null;
    // What she bought, what each service holds, until when, and the tax invoice.
    // Never throws: the membership is hers whether or not the mail lands.
    await afterResponse(`membership email for ${paymentId}`, () => sendMembershipEmail(bought.customerPackId, paymentId));
    return { kind: "pack", customerPackId: bought.customerPackId };
  }

  // Onto the visit it was bought for, the snapshot exactly as createBookings
  // writes it. booking_addons' primary key is what guarantees one of each per
  // visit: a second tap that got this far is refused here. A booking gone
  // meanwhile fails the insert on its foreign key.
  //
  // Add-ons with a duration move the booking's end. That is re-checked under
  // the same chair lock a new booking takes (reserveStations), so the time she
  // was offered cannot have been sold to someone else in between; if it was,
  // nothing is added and the purchase is not delivered.
  // Paid late, after her visit was over (a bank that held the payment,
  // StreamPay down): nothing can be brought to a chair she has left. Not
  // delivered, so refundOrCredit gives the money back. A payment on time was
  // checked against her visit a moment ago, before she was charged.
  const [visit] = await db
    .select({ branchId: bookings.branchId, status: bookings.status, endsAt: bookings.endsAt })
    .from(bookings)
    .where(eq(bookings.id, intent.bookingId))
    .limit(1);
  if (!visit) return null;
  if (late && (["completed", "cancelled", "no_show"].includes(visit.status) || visit.endsAt.getTime() < Date.now())) {
    return null;
  }

  const extraMin = intent.items.reduce((s, i) => s + i.durationMin, 0);
  const write = async (tx: Tx) => {
    if (extraMin > 0) {
      const [b] = await tx
        .select({ branchId: bookings.branchId, stationId: bookings.stationId, startsAt: bookings.startsAt, endsAt: bookings.endsAt })
        .from(bookings)
        .where(eq(bookings.id, intent.bookingId))
        .limit(1);
      if (!b?.stationId) throw new Error("booking has no chair");
      const endsAt = new Date(b.endsAt.getTime() + extraMin * 60_000);
      const held = await reserveStations(tx, b.branchId, b.startsAt, endsAt, 1, {
        ignoreBookingIds: [intent.bookingId],
        onlyStationId: b.stationId,
      });
      if (!held) throw new Error("the time after her was taken");
      await tx.update(bookings).set({ endsAt, updatedAt: new Date() }).where(eq(bookings.id, intent.bookingId));
    }
    await tx.insert(bookingAddons).values(
      intent.items.map((i) => ({
        bookingId: intent.bookingId,
        addonId: i.addonId,
        name: i.name,
        priceHalalas: i.priceHalalas,
      })),
    );
    // `treat_booking_id`, not `booking_id` — see the schema comment. Putting it
    // in `booking_id` would collide with payments_booking_live_unique.
    await tx
      .update(payments)
      .set({ treatBookingId: intent.bookingId, updatedAt: new Date() })
      .where(eq(payments.id, paymentId));
  };
  // Time added after her: a lapsed hold there reads as free on the chair's
  // screen, so it is let go before the chair is claimed, not refused after she paid.
  if (extraMin > 0) await withLapsedHoldsReleased(visit.branchId, write);
  else await db.transaction(write);
  // Her receipt: what was added, the new finish time, the tax invoice. Never throws.
  await afterResponse(`visit email for ${paymentId}`, () => sendVisitEmail(intent.bookingId, paymentId, intent.items));
  return { kind: "treat", names: intent.items.map((i) => i.name) };
}

/** What an already-paid row delivered, for a second settle or a status poll. */
async function deliveredOf(row: typeof payments.$inferSelect, intent: Intent): Promise<Delivered | null> {
  if (intent.kind === "gift_card") {
    if (!row.giftCardId) return null;
    const [card] = await db
      .select({ code: giftCards.code })
      .from(giftCards)
      .where(eq(giftCards.id, row.giftCardId))
      .limit(1);
    return card ? { kind: "gift_card", code: card.code } : null;
  }
  if (intent.kind === "pack") {
    return row.customerPackId ? { kind: "pack", customerPackId: row.customerPackId } : null;
  }
  return row.treatBookingId ? { kind: "treat", names: intent.items.map((i) => i.name) } : null;
}

async function markFailed(ref: string) {
  await db
    .update(payments)
    .set({ status: "failed", updatedAt: new Date() })
    .where(and(eq(payments.providerRef, ref), eq(payments.status, "pending")));
}

async function saveCheckout(ref: string, raw: unknown) {
  await db
    .update(payments)
    .set({ raw: mergeRaw(payments.raw, raw), updatedAt: new Date() })
    .where(eq(payments.providerRef, ref));
}
