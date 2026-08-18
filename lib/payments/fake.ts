// Stand-in gateway: approves everything, unless a dev caller asks for a decline.
//
// Real money is never moved. Deploying with this driver active means customers
// book for free — docs/DEPLOYMENT.md §0 says as much, and PAYMENT_DRIVER has to
// point at a real provider before the site takes public traffic.

import type { ChargeInput, ChargeResult, PaymentDriver } from "./index";

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
};
