// The group picker's own subtraction (lib/booking.ts subtractPartyHolds).
//
// Four friends each ask /api/availability on their own, because nothing about a
// party is written down until somebody pays. The server answers each of them
// honestly and identically: the branch's last chair is free. All four pick it,
// and createBookings refuses the whole party at payment.
//
// Pure input/output, no database and no browser — the rule is arithmetic on a
// list of intervals, and the reason it lives in lib/ rather than inside the
// component is so it can be asserted without rendering one.

import { describe, expect, it } from "vitest";
import { subtractPartyHolds, type HoldableSlot } from "@/lib/booking";

/** 2031-05-06, so nothing here can collide with a real clock. */
const at = (hour: number, minute = 0) =>
  new Date(Date.UTC(2031, 4, 6, hour, minute)).toISOString();

const slot = (hour: number, freeCount: number, minute = 0): HoldableSlot => ({
  startsAt: at(hour, minute),
  available: true,
  blockedBy: null,
  freeCount,
});

const isOpen = (slots: HoldableSlot[], i: number) => slots[i].available;

describe("subtractPartyHolds", () => {
  it("leaves the grid alone when nobody else has booked", () => {
    const slots = [slot(9, 1), slot(10, 1)];
    expect(subtractPartyHolds(slots, 60, [])).toBe(slots);
  });

  it("closes the last chair once a friend is already sitting in it", () => {
    // The bug, exactly: one chair, and a friend already on 10:00.
    const out = subtractPartyHolds([slot(10, 1)], 60, [
      { startsAt: at(10), durationMin: 60 },
    ]);
    expect(isOpen(out, 0)).toBe(false);
    expect(out[0].blockedBy).toBe("full");
  });

  it("keeps the hour open when there is a chair left over", () => {
    const out = subtractPartyHolds([slot(10, 2)], 60, [
      { startsAt: at(10), durationMin: 60 },
    ]);
    expect(isOpen(out, 0)).toBe(true);
  });

  it("counts each friend on the hour, not just that there is one", () => {
    // Three chairs, two friends already on it — the third is hers, the fourth
    // guest is out. A rule that only asked "is anyone here" would let all four
    // through on three chairs.
    const holds = [
      { startsAt: at(10), durationMin: 60 },
      { startsAt: at(10), durationMin: 60 },
    ];
    expect(isOpen(subtractPartyHolds([slot(10, 3)], 60, holds), 0)).toBe(true);
    expect(
      isOpen(
        subtractPartyHolds([slot(10, 3)], 60, [...holds, { startsAt: at(10), durationMin: 60 }]),
        0,
      ),
    ).toBe(false);
  });

  it("does not charge her for a friend who is not overlapping", () => {
    // The flexibility the group page exists for: one friend at 11:00 while she
    // takes 14:00. A blunter rule that counted every friend on the day would
    // hide an hour that is genuinely free, which is its own bug.
    const out = subtractPartyHolds([slot(14, 1)], 60, [
      { startsAt: at(11), durationMin: 60 },
    ]);
    expect(isOpen(out, 0)).toBe(true);
  });

  it("treats touching appointments as not overlapping", () => {
    // A friend from 09:00 to 10:00 and this guest from 10:00 — back to back on
    // one chair is exactly what a salon day is made of. Half-open intervals, the
    // same comparison lib/availability uses for its own conflict scan.
    const out = subtractPartyHolds([slot(10, 1)], 60, [
      { startsAt: at(9), durationMin: 60 },
    ]);
    expect(isOpen(out, 0)).toBe(true);
  });

  it("catches an overlap that starts partway through", () => {
    // Her friend runs 09:30–11:00; this guest wants 10:00–11:00. The starts do
    // not match, so anything comparing start times alone would wave it through.
    const out = subtractPartyHolds([slot(10, 1)], 60, [
      { startsAt: at(9, 30), durationMin: 90 },
    ]);
    expect(isOpen(out, 0)).toBe(false);
  });

  it("catches an overlap that begins after her but before she finishes", () => {
    // The mirror image: the friend starts at 10:30, inside this guest's hour.
    const out = subtractPartyHolds([slot(10, 1)], 60, [
      { startsAt: at(10, 30), durationMin: 60 },
    ]);
    expect(isOpen(out, 0)).toBe(false);
  });

  it("never re-opens an hour the server already refused", () => {
    // Too-soon and past keep their own reason. Overwriting them with "full"
    // would tell a customer the salon is busy when the truth is she needs to
    // give an hour's notice — the picker says different things about each.
    const tooSoon: HoldableSlot = { ...slot(9, 3), available: false, blockedBy: "too-soon" };
    const out = subtractPartyHolds([tooSoon], 60, [{ startsAt: at(9), durationMin: 60 }]);
    expect(out[0].blockedBy).toBe("too-soon");
    expect(out[0].available).toBe(false);
  });

  it("measures the overlap against this guest's own duration", () => {
    // She is booking three hours from 10:00; her friend is at 12:00. A rule that
    // used the friend's length, or a fixed hour, would call these separate.
    expect(isOpen(subtractPartyHolds([slot(10, 1)], 180, [{ startsAt: at(12), durationMin: 60 }]), 0)).toBe(false);
    expect(isOpen(subtractPartyHolds([slot(10, 1)], 60, [{ startsAt: at(12), durationMin: 60 }]), 0)).toBe(true);
  });
});
