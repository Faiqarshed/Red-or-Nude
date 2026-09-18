// Fix 2: a refused party is told which guest could not be seated.
//
// The all-or-nothing refusal is the behaviour we want and is not under test
// here beyond confirming it holds — they came out together, so seating three of
// four is not what anybody asked for. What is under test is the *index*: with
// four guests holding four hours at up to four branches, "that time has gone"
// names nothing the customer can act on.
//
// The index has to survive three hops: the reservation loop that knows it, the
// result type, and the JSON the checkout reads. A test that only checks the
// first would pass while the customer still saw a generic message.

import { beforeEach, describe, expect, it } from "vitest";
import { createBooking, createBookings } from "@/lib/bookings";
import { content } from "@/lib/dictionary";

const { ar, en } = content;
import { FUTURE, TEST_PHONE, fixtures, groupRows, reset, type Fixtures } from "./helpers";

let f: Fixtures;

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
});

/** Fill every chair at a branch for one hour, so nobody else can be seated. */
async function fillBranch(branchId: string, chairs: number, at: number) {
  for (let i = 0; i < chairs; i++) {
    const made = await createBooking({
      branchId,
      serviceId: f.svcA.id,
      addonIds: [],
      startsAt: new Date(at).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "walk_in",
    });
    expect(made.ok, `could not fill chair ${i + 1}`).toBe(true);
  }
}

/** Book a party in which exactly one guest — `blocked` — has nowhere to sit. */
async function partyWithOneBlocked(blocked: number, size: number) {
  const at = FUTURE;
  // Self-contained: a test that calls this twice must start from an empty floor
  // the second time, or the fixture fills a branch that is already full.
  await reset(f.branchA, f.branchB);
  await fillBranch(f.branchB, f.chairsB, at);

  const members = Array.from({ length: size }, (_, i) => ({
    serviceId: i % 2 === 0 ? f.svcA.id : f.svcB.id,
    addonIds: [] as string[],
    // Everyone else sits at branch A, which has room.
    ...(i === blocked ? { branchId: f.branchB } : {}),
  }));

  return createBookings({
    branchId: f.branchA,
    startsAt: new Date(at).toISOString(),
    customer: { phone: TEST_PHONE },
    source: "web",
    status: "pending",
    members,
  });
}

describe("the refusal carries the guest", () => {
  it("names the second of two", async () => {
    const refused = await partyWithOneBlocked(1, 2);

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBe("slot-taken");
    expect(refused.guestIndex).toBe(1);
  });

  it.each([0, 1, 2, 3])("names guest at index %i of four", async (blocked) => {
    const refused = await partyWithOneBlocked(blocked, 4);

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBe("slot-taken");
    expect(refused.guestIndex).toBe(blocked);
  });

  it("does not simply always answer zero", async () => {
    // The assertion the whole fix turns on. A refusal that pointed at the first
    // guest every time would satisfy "an index is present" and still be wrong.
    const second = await partyWithOneBlocked(1, 2);
    const first = await partyWithOneBlocked(0, 2);

    expect(second.ok ? -1 : second.guestIndex).toBe(1);
    expect(first.ok ? -1 : first.guestIndex).toBe(0);
  });

  it("refuses the whole party, seating nobody", async () => {
    const refused = await partyWithOneBlocked(1, 3);
    expect(refused.ok).toBe(false);

    // Nothing of this party may survive: not the guests who could have sat.
    const { db } = await import("@/lib/db");
    const { bookings } = await import("@/lib/db/schema");
    const { and, eq, gte } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(bookings)
      .where(
        and(eq(bookings.branchId, f.branchA), gte(bookings.startsAt, new Date(FUTURE))),
      );
    expect(rows, "a refused party leaves no rows behind").toHaveLength(0);
  });
});

describe("the index is only claimed where it means something", () => {
  it("is absent when a party is refused for being on two days", async () => {
    const refused = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "web",
      status: "pending",
      members: [
        { serviceId: f.svcA.id, addonIds: [] },
        {
          serviceId: f.svcB.id,
          addonIds: [],
          startsAt: new Date(FUTURE + 26 * 3600_000).toISOString(),
        },
      ],
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBe("different-day");
    expect(refused.guestIndex).toBeUndefined();
  });

  it("is absent when the service does not exist", async () => {
    const refused = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "web",
      status: "pending",
      members: [{ serviceId: "00000000-0000-0000-0000-000000000000", addonIds: [] }],
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBe("invalid-service");
    expect(refused.guestIndex).toBeUndefined();
  });

  it("still refuses a solo booking with an index of zero, which the checkout ignores", async () => {
    await fillBranch(f.branchB, f.chairsB, FUTURE);

    const refused = await createBookings({
      branchId: f.branchB,
      startsAt: new Date(FUTURE).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "web",
      status: "pending",
      members: [{ serviceId: f.svcA.id, addonIds: [] }],
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBe("slot-taken");
    // Truthfully 0 — she is the only guest. The checkout falls back to the
    // unnamed line for a party of one, which is asserted below.
    expect(refused.guestIndex).toBe(0);
  });
});

describe("the words the customer actually reads", () => {
  it("has a named refusal in both languages", () => {
    expect(en.payment.slotTakenGuest).toBeTruthy();
    expect(ar.payment.slotTakenGuest).toBeTruthy();
  });

  it("leaves a {name} slot for the guest in both languages", () => {
    expect(en.payment.slotTakenGuest).toContain("{name}");
    expect(ar.payment.slotTakenGuest).toContain("{name}");
  });

  it("keeps the unnamed line for a solo booking", () => {
    expect(en.payment.slotTaken).toBeTruthy();
    expect(en.payment.slotTaken).not.toContain("{name}");
    expect(ar.payment.slotTaken).not.toContain("{name}");
  });

  it("still numbers guests for the fallback label", () => {
    // What the checkout falls back to when the group screen took no name.
    expect(en.booking.guestN).toContain("{n}");
    expect(ar.booking.guestN).toContain("{n}");
    expect(en.booking.guestN.replace("{n}", "3")).toBe("Guest 3");
  });
});

describe("the checkout's own choice of message", () => {
  // The page's branch, lifted out so the rule can be asserted without a browser.
  // Kept identical to app/(site)/booking/payment/page.tsx — if that changes and
  // this is not changed with it, the duplication is the bug this would catch.
  const chooseMessage = (
    guestIndex: unknown,
    members: { guestName: string | null }[],
    c = en,
  ): string => {
    const who =
      typeof guestIndex === "number" && members.length > 1
        ? members[guestIndex]?.guestName || c.booking.guestN.replace("{n}", String(guestIndex + 1))
        : null;
    return who ? c.payment.slotTakenGuest.replace("{name}", who) : c.payment.slotTaken;
  };

  it("uses the name the group screen took", () => {
    const msg = chooseMessage(1, [{ guestName: null }, { guestName: "Hessa" }]);
    expect(msg).toContain("Hessa");
    expect(msg).not.toContain("{name}");
  });

  it("falls back to a numbered guest when no name was given", () => {
    const msg = chooseMessage(2, [
      { guestName: null },
      { guestName: null },
      { guestName: null },
    ]);
    expect(msg).toContain("Guest 3");
  });

  it("says nothing about a guest on a solo booking", () => {
    expect(chooseMessage(0, [{ guestName: null }])).toBe(en.payment.slotTaken);
  });

  it("falls back safely when the server sent no index", () => {
    expect(chooseMessage(undefined, [{ guestName: null }, { guestName: null }])).toBe(
      en.payment.slotTaken,
    );
  });

  it("falls back safely when the index points past the party", () => {
    // A stale tab could post two guests and read a reply about a third.
    expect(chooseMessage(9, [{ guestName: null }, { guestName: null }])).toContain("Guest 10");
  });

  it("works in Arabic too", () => {
    const msg = chooseMessage(1, [{ guestName: null }, { guestName: null }], ar);
    expect(msg).toContain(ar.booking.guestN.replace("{n}", "2"));
    expect(msg).not.toContain("{name}");
  });
});

describe("the reservation loop still seats a party it can seat", () => {
  it("does not refuse when there is room for everyone", async () => {
    const party = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "web",
      status: "pending",
      members: [
        { serviceId: f.svcA.id, addonIds: [] },
        { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
      ],
    });

    expect(party.ok, party.ok ? "" : party.error).toBe(true);
    if (!party.ok) return;
    expect(await groupRows(party.groupId!)).toHaveLength(2);
  });

  it("refuses the guest who overflows a branch, not the one who fits", async () => {
    // Branch A has room for exactly its chairs. Fill it, then ask for one more
    // there and one at the branch that is free: the index must point at the
    // guest whose branch is full, whichever position she holds.
    await fillBranch(f.branchA, f.chairsA, FUTURE);

    const refused = await createBookings({
      branchId: f.branchB,
      startsAt: new Date(FUTURE).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "web",
      status: "pending",
      members: [
        { serviceId: f.svcA.id, addonIds: [] },
        { serviceId: f.svcB.id, addonIds: [], branchId: f.branchA },
      ],
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBe("slot-taken");
    expect(refused.guestIndex).toBe(1);
  });
});
