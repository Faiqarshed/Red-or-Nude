// Properties, not examples.
//
// The suites next door assert particular cases somebody thought of. These
// generate parties at random — size, branches, hours, services, add-ons — and
// assert the things that must be true of *every* booking the engine produces.
// A case nobody thought of is exactly where the next bug is.
//
// The generator is seeded, so a failure is reproducible: the seed is printed
// with the party that broke it.

import { beforeEach, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { addons, bookings } from "@/lib/db/schema";
import { createBookings, type BookingMember } from "@/lib/bookings";
import { splitGroupPrice, shareAmount, vatIncludedIn } from "@/lib/money";
import { utcToLocalDate } from "@/lib/availability";
import { FUTURE, TEST_PHONE, fixtures, reset, type Fixtures } from "./helpers";

let f: Fixtures;
let checkoutAddonIds: string[] = [];
let serviceAddonIds: string[] = [];

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
  const rows = await db.select().from(addons);
  checkoutAddonIds = rows.filter((a) => a.atCheckout).map((a) => a.id);
  serviceAddonIds = rows.filter((a) => !a.atCheckout).map((a) => a.id);
});

/** Deterministic PRNG, so a failing case can be replayed from its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

type Party = {
  branchId: string;
  startsAt: string;
  members: BookingMember[];
};

/** A party the engine ought to accept: same day, one to four guests. */
function makeParty(seed: number): Party {
  const rand = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const size = 1 + Math.floor(rand() * 4);

  // Hours spread over one local day, well inside it so no guest rolls over.
  const hourOf = (i: number) => FUTURE + Math.floor(rand() * 6) * 3600_000 + i * 0;

  const members: BookingMember[] = Array.from({ length: size }, (_, i) => {
    const m: BookingMember = {
      serviceId: pick([f.svcA.id, f.svcB.id]),
      addonIds: rand() < 0.4 && serviceAddonIds.length ? [pick(serviceAddonIds)] : [],
    };
    if (rand() < 0.5) m.branchId = pick([f.branchA, f.branchB]);
    if (rand() < 0.6) m.startsAt = new Date(hourOf(i)).toISOString();
    if (rand() < 0.3 && checkoutAddonIds.length) {
      m.addonIds = [...m.addonIds, pick(checkoutAddonIds)];
    }
    return m;
  });

  return {
    branchId: pick([f.branchA, f.branchB]),
    startsAt: new Date(FUTURE).toISOString(),
    members,
  };
}

describe("pure money rules hold for any shape", () => {
  it("a group's guest totals always add back to the bill exactly", () => {
    const rand = rng(99);
    for (let n = 0; n < 400; n++) {
      const size = 1 + Math.floor(rand() * 4);
      const grosses = Array.from({ length: size }, () => Math.floor(rand() * 100_000));
      const percent = Math.floor(rand() * 101);

      const split = splitGroupPrice(grosses, percent);
      const grossTotal = grosses.reduce((a, b) => a + b, 0);
      const expected = grossTotal - Math.round((grossTotal * percent) / 100);

      expect(split.reduce((s, x) => s + x.totalHalalas, 0)).toBe(expected);
      // Nobody is charged a negative amount or given a negative discount.
      for (const s of split) {
        expect(s.totalHalalas).toBeGreaterThanOrEqual(0);
        expect(s.discountHalalas).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("a shared amount is never over-allocated", () => {
    const rand = rng(7);
    for (let n = 0; n < 400; n++) {
      const size = 1 + Math.floor(rand() * 4);
      const totals = Array.from({ length: size }, () => Math.floor(rand() * 50_000));
      const pot = totals.reduce((a, b) => a + b, 0);
      const amount = Math.floor(rand() * (pot + 1));

      const shares = shareAmount(totals, amount);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(amount);
      shares.forEach((s, i) => {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s, "a guest's share exceeded what she owed").toBeLessThanOrEqual(totals[i]);
      });
    }
  });

  it("VAT is never more than the total it came out of", () => {
    const rand = rng(31);
    for (let n = 0; n < 400; n++) {
      const total = Math.floor(rand() * 200_000);
      const percent = Math.floor(rand() * 26);
      const vat = vatIncludedIn(total, percent);
      expect(vat).toBeGreaterThanOrEqual(0);
      expect(vat).toBeLessThanOrEqual(total);
    }
  });
});

describe("every party the engine accepts obeys the rules", () => {
  it("holds for 40 randomly shaped parties", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      await reset(f.branchA, f.branchB);
      const party = makeParty(seed);
      const where = `seed ${seed}: ${JSON.stringify(party.members)}`;

      const made = await createBookings({
        ...party,
        customer: { phone: TEST_PHONE },
        source: "web",
        status: "pending",
      });

      // A refusal is a legitimate answer — chairs run out. What is not
      // legitimate is a refusal that left rows behind, checked below.
      if (!made.ok) {
        const leftovers = await db
          .select()
          .from(bookings)
          .where(inArray(bookings.branchId, [f.branchA, f.branchB]));
        expect(leftovers, `refused but left rows behind — ${where}`).toHaveLength(0);
        continue;
      }

      const rows = await db
        .select()
        .from(bookings)
        .where(inArray(bookings.branchId, [f.branchA, f.branchB]));

      expect(rows, `wrong number of rows — ${where}`).toHaveLength(party.members.length);

      // 1. Every guest sits at the branch she asked for.
      const wanted = party.members.map((m) => m.branchId ?? party.branchId).sort();
      expect(rows.map((r) => r.branchId).sort(), `branch mismatch — ${where}`).toEqual(wanted);

      // 2. Every guest starts when she asked to.
      const wantedStarts = party.members
        .map((m) => new Date(m.startsAt ?? party.startsAt).getTime())
        .sort();
      expect(rows.map((r) => r.startsAt.getTime()).sort()).toEqual(wantedStarts);

      // 3. One local day for the whole party — the rule that makes it a group.
      const days = new Set(rows.map((r) => utcToLocalDate(r.startsAt)));
      expect(days.size, `party spans ${days.size} days — ${where}`).toBe(1);

      // 4. Nobody is charged a negative amount, and VAT stays inside the total.
      for (const r of rows) {
        expect(r.totalHalalas, `negative total — ${where}`).toBeGreaterThanOrEqual(0);
        expect(r.vatHalalas).toBeGreaterThanOrEqual(0);
        expect(r.vatHalalas).toBeLessThanOrEqual(r.totalHalalas);
        expect(Number.isInteger(r.totalHalalas), `money stopped being an integer — ${where}`).toBe(
          true,
        );
      }

      // 5. Every guest ends after she starts.
      for (const r of rows) {
        expect(r.endsAt.getTime(), `ends before it starts — ${where}`).toBeGreaterThan(
          r.startsAt.getTime(),
        );
      }

      // 6. No chair holds two overlapping guests.
      const byChair = new Map<string, { s: number; e: number }[]>();
      for (const r of rows) {
        const held = byChair.get(r.stationId!) ?? [];
        for (const h of held) {
          const clash = r.startsAt.getTime() < h.e && h.s < r.endsAt.getTime();
          expect(clash, `chair double-booked — ${where}`).toBe(false);
        }
        held.push({ s: r.startsAt.getTime(), e: r.endsAt.getTime() });
        byChair.set(r.stationId!, held);
      }

      // 7. A group shares one id; a solo booking has none.
      const groupIds = new Set(rows.map((r) => r.groupId));
      expect(groupIds.size, `group id is not shared — ${where}`).toBe(1);
      if (party.members.length === 1) {
        expect(rows[0].groupId, `a solo booking took a group id — ${where}`).toBeNull();
      } else {
        expect(rows[0].groupId, `a group has no group id — ${where}`).toBeTruthy();
      }

      // 8. A pending hold is never numbered.
      expect(rows.every((r) => r.ticketNo === null), `held but numbered — ${where}`).toBe(true);
    }
  });
});
