// Stand-in gateway: approves everything, unless a dev caller asks for a decline.
//
// Real money is never moved. Deploying with this driver active means customers
// book for free — docs/DEPLOYMENT.md §0 says as much. In production it is only
// used when PAYMENT_DRIVER=fake says so out loud (lib/payments/index.ts).
//
// It answers on the spot, never `pending`, so verify() and cancel() are never
// reached through it.

import type { ChargeInput, ChargeResult, PaymentDriver, RefundInput, RefundResult } from "./index";

export const fakeDriver: PaymentDriver = {
  name: "fake",

  async charge(input: ChargeInput): Promise<ChargeResult> {
    // Dev-only: a production caller cannot talk its way into a decline.
    const declined = input.simulate === "decline" && process.env.NODE_ENV !== "production";
    return {
      status: declined ? "failed" : "paid",
      raw: {
        driver: "fake",
        amountHalalas: input.amountHalalas,
        at: new Date().toISOString(),
      },
    };
  },

  async verify() {
    return { status: "failed" };
  },

  async cancel() {},

  async refundedHalalas() {
    return 0;
  },

  async listPayments() {
    return [];
  },

  // No decline path here on purpose. A real gateway can refuse a refund and
  // lib/payments/refund.ts handles that, but the fake driver never took the
  // money in the first place, so there is nothing it could plausibly fail on.
  async refund(input: RefundInput): Promise<RefundResult> {
    return {
      status: "refunded",
      raw: {
        driver: "fake",
        refundedHalalas: input.amountHalalas,
        reason: input.reason ?? null,
        at: new Date().toISOString(),
      },
    };
  },
};
