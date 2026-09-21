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
import { db } from "@/lib/db";
import { bookingAddons, giftCards, payments } from "@/lib/db/schema";
import { issueGiftCard } from "@/lib/giftcards";
import { sendGiftCardEmails } from "@/lib/giftcard/email";
import { notify } from "@/lib/notify";
import { buyPack } from "@/lib/packs";
import { siteOrigin } from "@/lib/site";
import { refundRef } from "./refund";
import { getDriver, mergeRaw, PAY_WINDOW_MIN, type Line, type Payer, type Verdict } from "./index";

export type GiftIntent = {
  kind: "gift_card";
  amountSar: number;
  designId: string | null;
  buyerName: string | null;
  buyerEmail: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
  message: string | null;
  lang: "ar" | "en";
};
export type PackIntent = { kind: "pack"; customerId: string; packId: string };
export type TreatIntent = {
  kind: "treat";
  bookingId: string;
  addonId: string;
  name: { ar: string; en: string };
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
  | { kind: "treat"; name: { ar: string; en: string } };

export type PurchaseResult =
  | { ok: true; delivered: Delivered }
  | { ok: true; checkout: { ref: string; url: string } }
  | {
      ok: false;
      /**
       * `not-delivered`: paid, and then it could not be handed over — a treat a
       * second tap already added, a pack withdrawn mid-checkout. The money has
       * been sent back (or the log says REFUND OWED); a retry is a new purchase.
       */
      error: "payment-declined" | "failed" | "not-delivered" | "not-found";
    };

export async function startPurchase(input: {
  intent: Intent;
  amountHalalas: number;
  line: Line;
  title: string;
  payer: Payer;
  /** The page to come back to after a full-window checkout. */
  back: string;
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
    raw: { intent: input.intent },
  });

  let charge;
  try {
    charge = await driver.charge({
      ref,
      amountHalalas: input.amountHalalas,
      lines: [input.line],
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
    return { ok: true, checkout: { ref, url: charge.checkoutUrl } };
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
    const url = (row.raw as { url?: string } | null)?.url;
    if (url && Date.now() - row.updatedAt.getTime() < DELIVERY_GRACE_MS) {
      return { ok: true, checkout: { ref, url } };
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
    return { ok: false, error: "failed" };
  }

  if (verdict.status === "pending") {
    const url = (row.raw as { url?: string }).url;
    return url ? { ok: true, checkout: { ref, url } } : { ok: false, error: "failed" };
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

  let delivered: Delivered | null = null;
  try {
    delivered = await deliver(row.id, intent, row.amountHalalas);
  } catch (err) {
    console.error(`[purchase] ${ref} (${intent.kind}) paid but not delivered`, err);
    // The grant and its link to this row commit together, so the row is the
    // truth: a step after them (an email, a notify) may be what threw.
    const [fresh] = await db.select().from(payments).where(eq(payments.id, row.id)).limit(1);
    if (fresh) delivered = await deliveredOf(fresh, intent);
  }

  if (!delivered) {
    const back = row.amountHalalas > 0 ? await refundRef(ref, "not-delivered") : { ok: true };
    console.error(`[purchase] ${ref}: ${back.ok ? "refunded" : "REFUND OWED — settle by hand"}`);
    return { ok: false, error: "not-delivered" };
  }
  return { ok: true, delivered };
}

async function deliver(paymentId: string, intent: Intent, amountHalalas: number): Promise<Delivered | null> {
  if (intent.kind === "gift_card") {
    const card = await issueGiftCard({
      paymentId,
      amountHalalas,
      designId: intent.designId,
      buyerName: intent.buyerName,
      buyerEmail: intent.buyerEmail,
      recipientName: intent.recipientName,
      recipientEmail: intent.recipientEmail,
      recipientPhone: intent.recipientPhone,
      message: intent.message,
      expiresInMonths: 12,
    });
    if (!card.ok) return null;

    // Delivery. The buyer still gets a WhatsApp share button on the success
    // screen — this is the automatic half. Email really sends (SMTP); WhatsApp
    // goes through notify(), log-only until a provider is chosen. Two paths on
    // purpose — see docs/INVOICE-EMAIL.md §7. Neither can fail the sale.
    await sendGiftCardEmails({
      code: card.code,
      amountSar: intent.amountSar,
      senderName: intent.buyerName,
      recipientName: intent.recipientName,
      recipientEmail: intent.recipientEmail,
      buyerEmail: intent.buyerEmail,
      message: intent.message,
      expiresAt: card.expiresAt,
      lang: intent.lang,
    });
    if (intent.recipientPhone) {
      await notify({
        channel: "whatsapp",
        to: intent.recipientPhone,
        template: "gift-card",
        lang: intent.lang,
        data: {
          code: card.code,
          amountSar: intent.amountSar,
          senderName: intent.buyerName,
          recipientName: intent.recipientName,
          message: intent.message,
          cardUrl: `/gift/${card.code}`,
        },
      });
    }
    return { kind: "gift_card", code: card.code };
  }

  if (intent.kind === "pack") {
    const bought = await buyPack(intent.customerId, intent.packId, new Date(), paymentId);
    if (!bought.ok) return null;
    return { kind: "pack", customerPackId: bought.customerPackId };
  }

  // A treat, onto the visit it was bought for. The snapshot exactly as
  // createBookings writes it. booking_addons' primary key is what guarantees
  // one per visit: a second tap that got this far is refused here and refunded.
  // A booking gone meanwhile fails the insert on its foreign key.
  await db.transaction(async (tx) => {
    await tx.insert(bookingAddons).values({
      bookingId: intent.bookingId,
      addonId: intent.addonId,
      name: intent.name,
      priceHalalas: amountHalalas,
    });
    // `treat_booking_id`, not `booking_id` — see the schema comment. Putting it
    // in `booking_id` would collide with payments_booking_live_unique.
    await tx
      .update(payments)
      .set({ treatBookingId: intent.bookingId, updatedAt: new Date() })
      .where(eq(payments.id, paymentId));
  });
  return { kind: "treat", name: intent.name };
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
  return row.treatBookingId ? { kind: "treat", name: intent.name } : null;
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
