// The booking email names each discount for what it was.
//
// It used to call everything but a promo code "Group booking discount", so 200
// SAR of loyalty points printed as a group discount on a solo booking. Each
// discount is now its own line, split the one way the StreamPay lines split it
// (discountParts).

import { describe, expect, it } from "vitest";
import { discountParts } from "@/lib/money";
import { renderInvoiceEmail } from "@/lib/invoice/template";
import type { InvoiceData } from "@/lib/invoice/data";

function invoice(lang: "ar" | "en", discounts: InvoiceData["guests"][number]["discounts"], promoCode: string | null = null): InvoiceData {
  const off = discounts.reduce((n, d) => n + d.halalas, 0);
  return {
    seller: { name: "Red or Nude", branchName: null, branchAddress: null, branchPhone: null },
    customer: { name: "Sara", email: "sara@test.local", phone: null, lang },
    startsAt: new Date("2031-05-14T06:00:00Z"),
    method: null,
    providerRef: null,
    guests: [
      {
        code: "RON-TEST",
        ticketNo: null,
        stationLabel: null,
        technicianName: null,
        lines: [{ label: { ar: "مانيكير", en: "Manicure" }, amountHalalas: 20_000 }],
        discounts,
        discountHalalas: off,
        totalHalalas: 20_000 - off,
      },
    ],
    promoCode,
    discountHalalas: off,
    totalHalalas: 20_000 - off,
    taxInvoiceUrl: null,
    memberships: [],
    giftCardLeft: 0,
  };
}

describe("the booking email's discounts", () => {
  it("calls points points, not a group discount", () => {
    const { text, html } = renderInvoiceEmail(invoice("en", [{ kind: "points", halalas: 20_000 }]));
    expect(text).toContain("Loyalty points");
    expect(text).not.toMatch(/group/i);
    expect(html).not.toMatch(/group/i);
  });

  it("calls a guest's gift card a gift card, in both languages", () => {
    expect(renderInvoiceEmail(invoice("en", [{ kind: "giftCard", halalas: 5_000 }])).text).toContain("Gift card");
    expect(renderInvoiceEmail(invoice("ar", [{ kind: "giftCard", halalas: 5_000 }])).text).toContain("بطاقة هدية");
  });

  it("gives each discount its own line", () => {
    const { text } = renderInvoiceEmail(
      invoice(
        "en",
        [
          { kind: "group", halalas: 2_000 },
          { kind: "promo", halalas: 1_000 },
          { kind: "points", halalas: 1_000 },
        ],
        "EID25",
      ),
    );
    expect(text).toContain("Group discount  −20.00");
    expect(text).toContain("Discount (EID25)  −10.00");
    expect(text).toContain("Loyalty points  −10.00");
  });

  it("says it in Arabic, for a group of any size", () => {
    const { text } = renderInvoiceEmail(invoice("ar", [{ kind: "group", halalas: 2_000 }]));
    expect(text).toContain("خصم الحجز الجماعي");
    expect(text).not.toContain("الثنائي");
  });
});

describe("a guest's gift card with something left", () => {
  it("says how much, and to sign in with her email to spend it", () => {
    const { text, html } = renderInvoiceEmail({ ...invoice("en", [{ kind: "wallet", halalas: 5_000 }]), giftCardLeft: 2_000 });
    expect(text).toContain("20 SAR is left on your gift card");
    expect(text).toContain("sara@test.local");
    expect(html).toContain("/account");
  });

  it("says nothing when the card is used up", () => {
    const { text } = renderInvoiceEmail(invoice("en", [{ kind: "wallet", halalas: 5_000 }]));
    expect(text).not.toContain("left on your gift card");
  });
});

describe("discountParts", () => {
  it("is what is left of the discount after promo, points and wallet", () => {
    expect(
      discountParts({
        discountHalalas: 30_000,
        promoDiscountHalalas: 5_000,
        pointsDiscountHalalas: 10_000,
        walletDiscountHalalas: 4_000,
      }),
    ).toEqual({ group: 11_000, promo: 5_000, points: 10_000, wallet: 4_000 });
  });
});
