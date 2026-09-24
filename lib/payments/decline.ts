// Why a card payment failed, from the gateway's own words.
//
// StreamPay keeps no record of a failed attempt (no invoice is made), so the
// only reason we ever get is the `message` on its redirect back to us, e.g.
// "3DS: Card authentication declined." — free text from the card network. It is
// sorted into a few reasons the customer can act on, each with its own message
// (lib/dictionary.ts `payDecline`), and the bank's text is shown beneath so an
// unrecognised one still says something true. Display only: nothing here
// confirms or refuses a payment.
//
// The patterns follow the messages in Moyasar's test-card table, the gateway
// behind StreamPay. Lost, stolen and unspecified stay a plain "declined": she
// is told to call her bank, not what the bank suspects.

export type DeclineReason =
  | "cancelled"
  | "insufficient"
  | "expired"
  | "limit"
  | "notEnrolled"
  | "unavailable"
  | "rejected"
  | "authFailed"
  | "declined";

/** Order matters: the first match wins, most specific first. */
const RULES: [RegExp, DeclineReason][] = [
  [/cancel/, "cancelled"],
  [/insufficient|not enough/, "insufficient"],
  [/expired card|card expired|expir/, "expired"],
  [/limit/, "limit"],
  // "enabled Online Purchase from your bank portal": the card is switched off for
  // online use, not the bank being down (Moyasar test card 4111118250252531).
  [/not enrolled|online purchase/, "notEnrolled"],
  [/not available|unavailable|service error|server error|system error|time ?out|timed out|try again later/, "unavailable"],
  [/reject/, "rejected"],
  [/3ds|3-d|authenticat|verif|otp/, "authFailed"],
];

export function declineReason(message: string | null | undefined): DeclineReason {
  const m = (message ?? "").toLowerCase();
  return RULES.find(([re]) => re.test(m))?.[1] ?? "declined";
}
