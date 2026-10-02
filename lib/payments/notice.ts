// What a payment that did not end in "paid" means for her money, read from the
// error code a checkout route or GET /api/payments/status answered with.
//
// One reading for all four checkouts (booking, gift card, membership, chair
// treats). Each page sorted the codes on its own before, and two of them told a
// customer who had been charged and refunded "nothing was charged — try again".
// Display only: nothing here decides a payment.

export type PayNotice = "declined" | "refunded" | "checking" | "expired" | "too-many" | "failed";

export function noticeOf(error: string | undefined): PayNotice {
  switch (error) {
    case "payment-declined":
    case "declined":
      return "declined";
    // Charged, nothing delivered, and the money is on its way back (the refund
    // rule). Each route names it its own way.
    case "not-delivered":
    case "paid-not-granted":
    case "paid-not-added":
      return "refunded";
    // StreamPay has not said, or another tab is paying: she may have paid.
    case "unconfirmed":
    case "unverified":
    case "in-progress":
      return "checking";
    case "expired":
      return "expired";
    case "too-many":
      return "too-many";
    default:
      return "failed";
  }
}

/** Whether the screen may say "nothing was charged". Only where nothing can have been. */
export function nothingCharged(notice: PayNotice): boolean {
  return notice === "declined" || notice === "expired" || notice === "too-many";
}
