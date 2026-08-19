// Stand-in gateway: approves everything, unless a dev caller asks for a decline.
//
// Real money is never moved. Deploying with this driver active means customers
// book for free — docs/DEPLOYMENT.md §0 says as much, and PAYMENT_DRIVER has to
// point at a real provider before the site takes public traffic.

import type {
  ChargeInput,
  ChargeResult,
  PaymentDriver,
  RefundInput,
  RefundResult,
} from "./index";

export const fakeDriver: PaymentDriver = {
  name: "fake",

  async charge(input: ChargeInput): Promise<ChargeResult> {
    const declined = input.simulate === "decline";
    return {
      status: declined ? "failed" : "paid",
      providerRef: input.ref,
      raw: {
        driver: "fake",
        amountHalalas: input.amountHalalas,
        method: input.method,
        at: new Date().toISOString(),
      },
    };
  },

  // No decline path here on purpose. A real gateway can refuse a refund and
  // lib/payments/refund.ts handles that, but the fake driver never took the
  // money in the first place, so there is nothing it could plausibly fail on.
  async refund(input: RefundInput): Promise<RefundResult> {
    return {
      status: "refunded",
      raw: {
        driver: "fake",
        providerRef: input.providerRef,
        refundedHalalas: input.amountHalalas,
        reason: input.reason ?? null,
        at: new Date().toISOString(),
      },
    };
  },
};
