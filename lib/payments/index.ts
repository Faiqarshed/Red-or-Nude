// Payment gateway seam.
//
// Nothing here talks to a real provider yet — Moyasar vs Tap is still an open
// decision (docs/ADMIN-PANEL.md §9). What matters is that everything *around*
// the gateway is real: bookings are held pending, `payments` rows are written,
// and confirmation only happens on a successful charge. Landing a real provider
// is then one new file implementing PaymentDriver plus one line in getDriver().

import type { paymentMethod } from "@/lib/db/schema";
import { fakeDriver } from "./fake";

export type PaymentMethod = (typeof paymentMethod.enumValues)[number];

export type ChargeInput = {
  /** Our reference for this attempt. Doubles as the provider's idempotency key. */
  ref: string;
  amountHalalas: number;
  method: PaymentMethod;
  /** Dev-only nudge to exercise the decline path. Ignored in production. */
  simulate?: "decline";
};

export type ChargeResult = {
  status: "paid" | "failed";
  /** The provider's own id once there is one; the fake driver echoes `ref`. */
  providerRef: string;
  raw?: unknown;
};

export type PaymentDriver = {
  name: string;
  charge(input: ChargeInput): Promise<ChargeResult>;
};

/** Branch on `process.env.PAYMENT_DRIVER` here once there is a second driver. */
export function getDriver(): PaymentDriver {
  return fakeDriver;
}
