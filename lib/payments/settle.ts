import "server-only";

// One door for "what became of payment `ref`?", whatever it was paying for.
// The return page, the status poll and the webhook all come through here, and
// the settle functions behind it are idempotent, so arriving three times for
// the same payment is fine.

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";
import { settleBookingPayment, type ConfirmedTicket } from "./confirm";
import { settlePurchase, type Delivered } from "./purchase";

export type Settled =
  | {
      status: "paid";
      result: { kind: "booking"; tickets: ConfirmedTicket[]; totalHalalas: number } | Delivered;
    }
  /** Still payable: `checkout` lets a page that lost it re-open the same one. */
  | { status: "pending"; checkout?: { ref: string; url: string } }
  | { status: "failed"; error: string };

export async function settlePayment(ref: string): Promise<Settled> {
  const [row] = await db
    .select({ bookingId: payments.bookingId })
    .from(payments)
    .where(eq(payments.providerRef, ref))
    .limit(1);
  if (!row) return { status: "failed", error: "not-found" };

  if (row.bookingId) {
    const r = await settleBookingPayment(ref);
    if (!r.ok) return { status: "failed", error: r.error };
    if ("checkout" in r) return { status: "pending", checkout: r.checkout };
    return { status: "paid", result: { kind: "booking", tickets: r.tickets, totalHalalas: r.totalHalalas } };
  }

  const r = await settlePurchase(ref);
  if (!r.ok) return { status: "failed", error: r.error };
  if ("checkout" in r) return { status: "pending", checkout: r.checkout };
  return { status: "paid", result: r.delivered };
}

/** Our ref for a StreamPay payment link, for a webhook that did not carry it. */
export async function refForLink(linkId: string): Promise<string | null> {
  const [row] = await db
    .select({ ref: payments.providerRef })
    .from(payments)
    .where(sql`${payments.raw}->>'linkId' = ${linkId}`)
    .limit(1);
  return row?.ref ?? null;
}
