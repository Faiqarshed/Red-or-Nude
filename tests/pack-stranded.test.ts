// The pack balance rule (lib/packs.ts spendableCredits).
//
// A credit comes off when the booking is *created*, which is before the customer
// has paid for anything — the chair is only being held. When that hold dies
// unpaid nothing gives the credit back: returnPackCredits is wired to the cancel
// button, and she cannot press it on a booking the sweep already cancelled. So
// she is down an appointment she bought, was never served for, and was never
// charged for.
//
// The rule therefore lives in the read, and this is the pure half of it.
// scripts/check-packs.ts asserts the same rule end to end against Postgres,
// including that spendPackCredit counts by it too.

import { describe, expect, it } from "vitest";
import { spendableCredits, type PackLedgerRow } from "@/lib/packs";

const HOLD_MIN = 15;
const NOW = new Date(Date.UTC(2031, 4, 6, 12, 0));
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

/** A `-1` against a booking in some state. */
const spend = (
  bookingStatus: string | null,
  bookingCancelReason: string | null = null,
  bookingCreatedAt: Date | null = minutesAgo(1),
): PackLedgerRow => ({
  delta: -1,
  reason: "booking",
  bookingStatus,
  bookingCancelReason,
  bookingCreatedAt,
});

/** The +n she was granted when she bought the pack. Belongs to no booking. */
const grant = (n: number): PackLedgerRow => ({
  delta: n,
  reason: "purchase",
  bookingStatus: null,
  bookingCancelReason: null,
  bookingCreatedAt: null,
});

const left = (...rows: PackLedgerRow[]) => spendableCredits(rows, HOLD_MIN, NOW);

describe("spendableCredits", () => {
  it("counts the grant when nothing has been spent", () => {
    expect(left(grant(6))).toBe(6);
  });

  it("counts a spend that was actually served", () => {
    expect(left(grant(6), spend("confirmed"), spend("completed"))).toBe(4);
  });

  // ---- the hole the brief named --------------------------------------------

  it("gives back a hold the sweep collected", () => {
    // Card declined, tab closed, fifteen minutes later sweepExpiredHolds cancels
    // it with payment-timeout. Nobody was served and nobody was charged.
    expect(left(grant(6), spend("cancelled", "payment-timeout"))).toBe(6);
  });

  it("gives it back before anything has swept it", () => {
    // The case that matters most: sweepExpiredHolds only runs when some *other*
    // customer books at that branch. A balance that waited for the sweep would
    // be wrong for hours, and lib/rewards.ts warns about this in the same words.
    expect(left(grant(6), spend("pending", null, minutesAgo(HOLD_MIN + 1)))).toBe(6);
  });

  it("treats a spend with no created_at as never redeemed", () => {
    // Should not happen. Guessing wrong in the other direction leaves a customer
    // unable to spend a credit she paid for, which is the worse failure.
    expect(left(grant(6), spend("pending", null, null))).toBe(6);
  });

  // ---- and the other side of it, or it would just say "packs never run out" --

  it("keeps a hold that is still inside its window", () => {
    // She may yet pay. A retry inside the window keeps its debit — same booking,
    // same row — which is correct, not a leak.
    expect(left(grant(6), spend("pending", null, minutesAgo(HOLD_MIN - 1)))).toBe(5);
  });

  it("holds the boundary at exactly the hold window", () => {
    // Strictly past, not at. A row that is precisely holdMin old is the last
    // moment the customer can still pay.
    expect(left(grant(6), spend("pending", null, minutesAgo(HOLD_MIN)))).toBe(5);
  });

  it("keeps the credit on a no-show, as the money is kept", () => {
    expect(left(grant(6), spend("no_show"))).toBe(5);
  });

  it("keeps the credit on a customer cancellation", () => {
    // Deliberately narrower than isDead() next door. returnPackCredits already
    // answers this one: inside cancel_cutoff_hours it writes a +1, outside it
    // writes nothing and the credit is spent exactly as the fee is kept.
    // Calling a cancellation dead here would return the credit a *second* time
    // on top of that +1, and delete the late-cancellation rule along the way.
    expect(left(grant(6), spend("cancelled", "customer"))).toBe(5);
  });

  it("does not double-credit a cancellation that was already refunded", () => {
    // What returnPackCredits leaves behind: the -1 and its matching +1.
    const back: PackLedgerRow = {
      delta: 1,
      bookingStatus: "cancelled",
      bookingCancelReason: "customer",
      bookingCreatedAt: minutesAgo(1),
    };
    expect(left(grant(6), spend("cancelled", "customer"), back)).toBe(6);
  });

  it("does not read a cancel reason off a booking that was not cancelled", () => {
    // cancel_reason is set alongside the status, but a stale one on a live row
    // must not strand a credit that was genuinely spent.
    expect(left(grant(6), spend("completed", "payment-timeout"))).toBe(5);
  });

  it("gives back a spend whose booking was deleted out from under it", () => {
    // `pack_txns.booking_id` is `on delete set null`, so a raw delete leaves the
    // `-1` pointing at nothing. The appointment does not exist, so nobody was
    // served for it — and the customer must not be charged a credit for an hour
    // that was erased. Real: a check script emptied the bookings table on
    // 2026-09-11 and took a live booking with it.
    expect(left(grant(8), spend(null))).toBe(8);
  });

  it("still counts an adjustment that never had a booking", () => {
    // The orphan rule keys on `reason`, not merely on a null booking. A hand
    // written credit or debit is not a redemption and must survive.
    const adjustment: PackLedgerRow = {
      delta: -1,
      reason: "adjustment",
      bookingStatus: null,
      bookingCancelReason: null,
      bookingCreatedAt: null,
    };
    expect(left(grant(8), adjustment)).toBe(7);
  });

  it("counts rows that belong to no booking at all", () => {
    // A grant, or an admin adjustment. There is no booking to judge, so there is
    // nothing to strand — and treating these as dead would zero every balance.
    expect(left(grant(3), grant(-1))).toBe(2);
  });

  it("adds up a whole messy ledger", () => {
    expect(
      left(
        grant(6),
        spend("completed"),
        spend("no_show"),
        spend("cancelled", "payment-timeout"),
        spend("pending", null, minutesAgo(HOLD_MIN + 60)),
        spend("pending", null, minutesAgo(2)),
      ),
    ).toBe(3);
  });
});
