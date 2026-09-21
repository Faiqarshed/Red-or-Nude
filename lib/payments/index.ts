// Payment gateway seam.
//
// Two drivers: StreamPay (lib/payments/streampay.ts), picked by
// PAYMENT_DRIVER=streampay, and the stand-in (./fake.ts) for dev, tests, and a
// staff-only deploy that sets PAYMENT_DRIVER=fake (docs/DEPLOYMENT.md §0).
//
// A real charge is not an answer, it is a handoff. StreamPay's reply to "charge
// this" is a checkout page the customer pays on, often via her bank's 3-D Secure
// step, and the verdict arrives later — on our return page or by webhook. So
// `charge()` may answer `pending` with a URL, and `verify()` is how either of
// those two later arrivals asks what actually happened. The fake driver still
// answers `paid` on the spot, which is why every flow keeps working unchanged
// without a gateway.

import { sql, type AnyColumn } from "drizzle-orm";
import type { paymentMethod } from "@/lib/db/schema";
import { fakeDriver } from "./fake";
import { streampayDriver } from "./streampay";

export type PaymentMethod = (typeof paymentMethod.enumValues)[number];

/**
 * How long one checkout stays payable, from the moment Pay is pressed. Long
 * enough for a bank's 3-D Secure page; the hold sweeper spares a chair with a
 * checkout this young (lib/bookings.ts), so she is not paying for a slot that
 * has just been given away.
 */
export const PAY_WINDOW_MIN = 10;

/** `payments.raw` with `obj`'s keys merged in — never replaced wholesale. */
export const mergeRaw = (raw: AnyColumn, obj: unknown) =>
  sql`coalesce(${raw}, '{}'::jsonb) || ${JSON.stringify(obj)}::jsonb`;

/**
 * True while a checkout for this booking can still be paid.
 *
 * A pending hold older than `booking_hold_min` counts as abandoned — unless
 * this says otherwise. The one copy of that exception, used by the hold sweeper
 * (lib/bookings.ts), the points balance (lib/loyalty.ts) and the pack-credit
 * balance (lib/packs.ts). Were they to disagree, points and credits would come
 * back to be spent again while the booking they paid for could still confirm.
 */
export const checkoutOpen = (bookingId: AnyColumn) => sql<boolean>`exists (
  select 1 from payments p
  where p.booking_id = ${bookingId}
    and p.status = 'pending'
    and p.created_at > now() - make_interval(mins => ${PAY_WINDOW_MIN})
)`;

/** One row of the receipt. `key` names the StreamPay product (see streampay.ts). */
export type Line = {
  key: string;
  name: string;
  priceHalalas: number;
  qty: number;
  /** Gift-card sales only, for now — see docs/PAYMENTS-STATUS.md. */
  vatExempt?: boolean;
};

/** A fixed amount off, worked out by us. Sent as a coupon named `label`. */
export type Discount = { label: string; halalas: number };

export type Payer = {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  customerId?: string | null;
};

export type ChargeInput = {
  /** Our reference for this attempt — `payments.provider_ref`, and what the webhook carries back. */
  ref: string;
  amountHalalas: number;
  /** Lines less discounts must equal `amountHalalas`, to the halala. */
  lines: Line[];
  discounts: Discount[];
  /** What the payment link is called in the gateway's dashboard. */
  title: string;
  payer: Payer;
  /** After this the checkout stops taking payments. */
  expiresAt: Date;
  /** Our return page. The gateway sends the customer back here either way. */
  returnUrl: string;
  /** Dev-only nudge to exercise the decline path. Ignored in production. */
  simulate?: "decline";
};

export type ChargeResult =
  | { status: "paid" | "failed"; raw?: unknown }
  /** Awaiting the customer. `raw` is what verify() and cancel() need later. */
  | { status: "pending"; checkoutUrl: string; raw: unknown };

export type Verdict =
  | {
      status: "paid";
      amountHalalas: number;
      method: PaymentMethod;
      /** Merged into `payments.raw`. Must carry whatever refund() needs. */
      raw: Record<string, unknown>;
    }
  | { status: "pending" }
  /** Declined, expired or cancelled — this attempt will never be paid. */
  | { status: "failed" };

export type RefundInput = {
  /** `payments.raw` of the paid attempt, as verify() left it. */
  raw: unknown;
  /**
   * How much to send back. Not necessarily the whole charge: a group is one
   * gateway transaction covering several bookings, so cancelling part of a
   * party is a partial refund of that one transaction.
   */
  amountHalalas: number;
  reason?: string;
};

export type RefundResult = {
  status: "refunded" | "failed";
  raw?: unknown;
};

export type PaymentDriver = {
  name: string;
  charge(input: ChargeInput): Promise<ChargeResult>;
  /** What became of a `pending` charge. Asked of the gateway, never of a URL. */
  verify(raw: unknown): Promise<Verdict>;
  /** Stop a `pending` checkout taking money. Best effort. */
  cancel(raw: unknown): Promise<void>;
  /** Send money back for a charge already made. See lib/payments/refund.ts. */
  refund(input: RefundInput): Promise<RefundResult>;
};

/**
 * Fails closed in production: a deploy that forgot PAYMENT_DRIVER would
 * otherwise hand out every booking free. A staff-only deploy that really wants
 * the stand-in says so with PAYMENT_DRIVER=fake.
 */
export function getDriver(): PaymentDriver {
  const driver = process.env.PAYMENT_DRIVER?.trim();
  if (driver === "streampay") return streampayDriver;
  if (driver === "fake" || process.env.NODE_ENV !== "production") return fakeDriver;
  throw new Error("[payments] PAYMENT_DRIVER must be 'streampay' (or 'fake' for a staff-only deploy)");
}
