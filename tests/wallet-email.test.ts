// The email that tells her a cancellation became wallet credit
// (docs/WALLET-PLAN.md, gap 2: there was no cancellation email at all).

import { describe, expect, it } from "vitest";
import { renderCancelCreditEmail } from "@/lib/wallet-email";

const base = {
  name: "Sara",
  amountHalalas: 15_000,
  balanceHalalas: 20_000,
  salonReason: null,
  guestEmail: null,
} as const;

describe("the cancel credit email", () => {
  it("says how much went to her wallet and what she now holds", () => {
    const { subject, text, html } = renderCancelCreditEmail({ ...base, lang: "en" });
    expect(subject).toMatch(/wallet/i);
    expect(text).toContain("150.00 SAR");
    expect(text).toContain("200.00 SAR");
    expect(html).toContain("150.00 SAR");
    // A credit, not a refund: nothing is on its way to her card.
    expect(text).not.toMatch(/card/i);
  });

  it("tells a guest which email to sign in with, and an account holder nothing of the sort", () => {
    const guest = renderCancelCreditEmail({ ...base, lang: "en", guestEmail: "sara@test.local" });
    expect(guest.text).toContain("sara@test.local");
    expect(guest.text).toContain("/account");

    const account = renderCancelCreditEmail({ ...base, lang: "en" });
    expect(account.text).not.toContain("Sign in");
  });

  it("gives the salon's reason when the salon cancelled", () => {
    const { text } = renderCancelCreditEmail({ ...base, lang: "en", salonReason: "Technician off sick" });
    expect(text).toContain("Technician off sick");
  });

  it("speaks Arabic to an Arabic customer", () => {
    const { subject, text } = renderCancelCreditEmail({ ...base, lang: "ar" });
    expect(subject).toMatch(/[؀-ۿ]/);
    expect(text).toContain("150.00");
  });

  it("escapes a reason typed at the desk", () => {
    const { html } = renderCancelCreditEmail({ ...base, lang: "en", salonReason: "<b>x</b>" });
    expect(html).not.toContain("<b>x</b>");
  });
});
