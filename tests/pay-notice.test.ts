// What a checkout page may tell her after a payment did not end in "paid".
//
// The four checkouts (booking, gift card, membership, chair treats) used to
// sort the error codes each on its own, and two of them answered a purchase
// that was charged and then refunded with "Payment failed, nothing was
// charged — try again". The rule is now one function; this pins that no code
// meaning "she may have paid" can ever be titled "nothing was charged".

import { describe, expect, it } from "vitest";
import { noticeOf, nothingCharged } from "@/lib/payments/notice";

describe("noticeOf", () => {
  it("reads every charged-then-refunded code as refunded, on every checkout", () => {
    // not-delivered: the status poll and the gift card route; paid-not-granted:
    // the membership route; paid-not-added: the chair route.
    for (const code of ["not-delivered", "paid-not-granted", "paid-not-added"]) {
      expect(noticeOf(code)).toBe("refunded");
    }
  });

  it("reads every 'StreamPay has not said yet' code as still checking", () => {
    for (const code of ["unconfirmed", "unverified", "in-progress"]) {
      expect(noticeOf(code)).toBe("checking");
    }
  });

  it("reads a decline, an expired hold and a throttle as what they are", () => {
    expect(noticeOf("payment-declined")).toBe("declined");
    expect(noticeOf("declined")).toBe("declined");
    expect(noticeOf("expired")).toBe("expired");
    expect(noticeOf("too-many")).toBe("too-many");
  });

  it("reads anything else, or nothing, as a plain failure", () => {
    expect(noticeOf("failed")).toBe("failed");
    expect(noticeOf("not-found")).toBe("failed");
    expect(noticeOf("a-code-added-next-year")).toBe("failed");
    expect(noticeOf(undefined)).toBe("failed");
  });

  it("says 'nothing was charged' only where nothing can have been", () => {
    expect(nothingCharged("declined")).toBe(true);
    expect(nothingCharged("expired")).toBe(true);
    expect(nothingCharged("too-many")).toBe(true);
    // Charged and refunded, may be charged, or not known: never.
    expect(nothingCharged("refunded")).toBe(false);
    expect(nothingCharged("checking")).toBe(false);
    expect(nothingCharged("failed")).toBe(false);
  });
});
