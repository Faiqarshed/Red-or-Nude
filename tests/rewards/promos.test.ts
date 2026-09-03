// Discount codes: the boundaries, the window, the cap, and who is allowed to
// decide what a bill is (brief §2.10).
//
// `scripts/check-promo.ts` already pins the pure arithmetic — what a code is
// worth, the refusal order, the min-total edge, the share split that has to add
// back up to the halala — and this file deliberately does not repeat it. It
// starts where that script stops, at everything the pure functions cannot see:
//
//   • the window through a real `timestamptz` column, not a Date in memory
//   • `quotePromo`'s lookup, including what a hostile code string does to it
//   • `countPromoUse` fired twice at once, which is the whole reason it
//     increments in SQL instead of reading and writing back
//   • the cap under concurrency, which promo.ts:128-136 documents as a known
//     and accepted ceiling — pinned here as characterization, not as spec
//   • `createBookings`, where the code is re-looked-up and re-priced against
//     totals the server computed itself
//
// What would be easy to break: trusting the browser's `totalHalalas`. The quote
// endpoint takes it and says what the code is worth against it, which is exactly
// as trustworthy as it sounds — and is fine only while the booking write ignores
// it entirely. Delete that second lookup and every test of the quote endpoint
// stays green while a customer can name their own bill.
//
// Register: docs/_testing/requirements-rewards.md — REQ-PRM-004…021, 030…042,
// REQ-PRM-A01/A02, REQ-STC-002.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, promoCodes } from "@/lib/db/schema";
import { Fixtures } from "../helpers/fixtures";
import { post, read, resetAppContext } from "../helpers/app";

vi.mock("next/headers", async () => (await import("../helpers/app")).headersMock);
vi.mock("next/cache", async () => (await import("../helpers/app")).cacheMock);

const fx = new Fixtures();
beforeEach(resetAppContext);
afterEach(() => fx.cleanup());

/** A Saturday well in the future, inside the 10:00–22:00 the fixture opens. */
const SLOT = "2030-03-02T11:00:00.000Z";
const NOW = new Date("2026-09-23T12:00:00.000Z");

let codeSeq = 0;
/**
 * A stored code. `promo_codes` is in the fixtures' teardown order but has no
 * builder, so this claims each row by id — the file never empties the table.
 */
async function storedCode(over: Partial<typeof promoCodes.$inferInsert> = {}) {
  const [row] = await db
    .insert(promoCodes)
    .values({
      code: `TEST${Date.now().toString(36).toUpperCase()}${codeSeq++}`,
      type: "percent",
      value: 25,
      ...over,
    })
    .returning();
  fx.claim(promoCodes, row.id);
  return row;
}

// ================================================= the window, through the DB

describe("the window, read back off a timestamptz column", () => {
  // check-promo.ts pins these against Dates in memory. The same boundaries have
  // to survive the round trip through Postgres, which is where a column stored
  // without a timezone would quietly move them by three hours.

  it("opens on the exact instant it starts and shuts on the exact instant it ends", async () => {
    const { quotePromo } = await import("@/lib/promo");
    const open = await storedCode({ startsAt: NOW, endsAt: new Date(NOW.getTime() + 60_000) });

    // Standing exactly on the start is open; a millisecond earlier is not.
    expect((await quotePromo(open.code, 20_000, NOW)).ok, "a code was shut on its own start").toBe(
      true,
    );
    const early = await quotePromo(open.code, 20_000, new Date(NOW.getTime() - 1));
    expect(early.ok).toBe(false);
    expect((early as { reason: string }).reason).toBe("not-started");

    const ends = new Date(NOW.getTime() + 60_000);
    // A millisecond before the end is live; the end itself is expired. Never
    // both, never neither.
    expect((await quotePromo(open.code, 20_000, new Date(ends.getTime() - 1))).ok).toBe(true);
    const onTheDot = await quotePromo(open.code, 20_000, ends);
    expect(onTheDot.ok, "a code was still live on the second it expired").toBe(false);
    expect((onTheDot as { reason: string }).reason).toBe("expired");
  });

  it("treats a null end of the window as that side being open forever", async () => {
    const { quotePromo } = await import("@/lib/promo");
    const noStart = await storedCode({ startsAt: null, endsAt: new Date(NOW.getTime() + 60_000) });
    const noEnd = await storedCode({ startsAt: new Date(NOW.getTime() - 60_000), endsAt: null });

    expect((await quotePromo(noStart.code, 20_000, NOW)).ok).toBe(true);
    // A decade on, a code with no end date is still a code with no end date.
    expect(
      (await quotePromo(noEnd.code, 20_000, new Date("2036-01-01T00:00:00.000Z"))).ok,
    ).toBe(true);
  });

  it("treats a null max_uses as uncapped, however often it has been used", async () => {
    const { quotePromo } = await import("@/lib/promo");
    const uncapped = await storedCode({ maxUses: null, uses: 9_999 });
    expect((await quotePromo(uncapped.code, 20_000, NOW)).ok, "an uncapped code ran out").toBe(
      true,
    );
  });
});

// ============================================== boundaries check-promo leaves

describe("what a code takes off a bill, at the edges", () => {
  const rule = (over: Partial<import("@/lib/promo").PromoRule> = {}) => ({
    type: "percent" as const,
    value: 25,
    minTotalHalalas: 0,
    startsAt: null,
    endsAt: null,
    maxUses: null,
    uses: 0,
    active: true,
    ...over,
  });

  it("discounts nothing off a bill of zero or less, before any percent maths", async () => {
    const { promoDiscount } = await import("@/lib/promo");
    expect(promoDiscount(rule(), 0)).toBe(0);
    // A negative bill is not a thing the salon can owe more of.
    expect(promoDiscount(rule(), -20_000), "a negative bill produced a discount").toBe(0);
    expect(promoDiscount(rule({ type: "fixed", value: 5_000 }), -1)).toBe(0);
  });

  it("rounds a half-halala up, once", async () => {
    const { promoDiscount } = await import("@/lib/promo");
    // 50% of one halala is half a halala. Half-up, and only once — the customer
    // is charged whole halalas either way.
    expect(promoDiscount(rule({ value: 50 }), 1)).toBe(1);
    expect(promoDiscount(rule({ value: 50 }), 3)).toBe(2);
    // 25% of 200.01 SAR is 50.0025 SAR — down, because it is below the half.
    expect(promoDiscount(rule({ value: 25 }), 20_001)).toBe(5_000);
  });

  it("never gives back more than the bill, whatever the code says", async () => {
    const { promoDiscount } = await import("@/lib/promo");
    // A 200% code is a data-entry mistake, not a refund.
    expect(promoDiscount(rule({ value: 200 }), 20_000)).toBe(20_000);
    expect(promoDiscount(rule({ type: "fixed", value: Number.MAX_SAFE_INTEGER }), 20_000)).toBe(
      20_000,
    );
  });

  // @characterization — undocumented, pins behaviour as of 2026-09-03.
  // A negative `value` is floored at zero rather than refused, so a code entered
  // wrongly cannot *increase* a bill. Nothing in docs/ says so; REQ-PRM-035.
  it("floors a negative code value at zero instead of adding to the bill", async () => {
    const { promoDiscount } = await import("@/lib/promo");
    expect(promoDiscount(rule({ type: "fixed", value: -5_000 }), 20_000)).toBe(0);
    expect(promoDiscount(rule({ value: -25 }), 20_000)).toBe(0);
  });
});

// ================================================== the lookup and the string

describe("finding a code the customer typed", () => {
  it("finds it in any casing, with whitespace round it, and echoes it back upper", async () => {
    const { quotePromo } = await import("@/lib/promo");
    const stored = await storedCode();

    const quote = await quotePromo(`  ${stored.code.toLowerCase()}  `, 20_000, NOW);
    expect(quote.ok, "a code typed in lower case was not found").toBe(true);
    expect((quote as { code: string }).code).toBe(stored.code);
  });

  it("keeps interior whitespace, because that is a different code", async () => {
    // normalizePromoCode trims the ends and upper-cases. It does not squash the
    // middle — "SUMMER SALE" and "SUMMERSALE" are two codes.
    const { normalizePromoCode } = await import("@/lib/promo");
    expect(normalizePromoCode("  summer sale  ")).toBe("SUMMER SALE");
    expect(normalizePromoCode("\tsummer\n")).toBe("SUMMER");
  });

  it("answers `unknown` for a code that is nothing but whitespace", async () => {
    const { quotePromo } = await import("@/lib/promo");
    for (const empty of ["", "   ", "\t\n"]) {
      const quote = await quotePromo(empty, 20_000, NOW);
      expect(quote.ok).toBe(false);
      expect((quote as { reason: string }).reason).toBe("unknown");
    }
  });

  it("survives a code string written to break out of the query", async () => {
    // Attack: SQL injection through the one user-supplied string this module
    // puts in a WHERE. The lookup is a parameterized equality, so the payload is
    // simply a code nobody has.
    const { quotePromo } = await import("@/lib/promo");
    const real = await storedCode();

    for (const payload of [
      "'; DROP TABLE promo_codes;--",
      "' OR '1'='1",
      "%",
      "_____",
      `${real.code}' --`,
    ]) {
      const quote = await quotePromo(payload, 20_000, NOW);
      expect(quote.ok, `\`${payload}\` matched a code`).toBe(false);
      expect((quote as { reason: string }).reason).toBe("unknown");
    }

    // The table, and the real code in it, are still there.
    expect((await quotePromo(real.code, 20_000, NOW)).ok).toBe(true);
  });

  it("tells the customer the minimum only on the refusal that has one", async () => {
    const { quotePromo } = await import("@/lib/promo");
    const tooSmall = await storedCode({ minTotalHalalas: 20_001 });
    const off = await storedCode({ active: false });

    const short = await quotePromo(tooSmall.code, 20_000, NOW);
    expect((short as { reason: string }).reason).toBe("min-total");
    expect((short as { minTotalHalalas?: number }).minTotalHalalas).toBe(20_001);

    // Every other refusal carries nothing extra — there is nothing useful to
    // say, and each extra field is another thing to tell a stranger.
    const inactive = await quotePromo(off.code, 20_000, NOW);
    expect((inactive as { minTotalHalalas?: number }).minTotalHalalas).toBeUndefined();
  });
});

// ============================================================ counting a use

describe("counting a redemption", () => {
  it("counts both of two confirmations landing at the same instant", async () => {
    // The reason the increment is `uses = uses + 1` in SQL: read-then-write
    // would have both confirmations compute 1 and the salon would undercount
    // every code it ever caps.
    const { countPromoUse } = await import("@/lib/promo");
    const code = await storedCode({ uses: 0 });

    await Promise.all([countPromoUse(code.id), countPromoUse(code.id)]);

    const [after] = await db.select().from(promoCodes).where(eq(promoCodes.id, code.id));
    expect(after.uses, "two redemptions were counted as one").toBe(2);
  });

  it("does not fail a paid booking because a count could not be written", async () => {
    // A miscounted redemption is a reporting problem. The money is already
    // taken and the booking is already confirmed by the time this runs.
    const { countPromoUse } = await import("@/lib/promo");
    await expect(countPromoUse("not-a-uuid")).resolves.toBeUndefined();
  });

  // @characterization — undocumented, pins behaviour as of 2026-09-03. REQ-PRM-042.
  it("updates nothing when the code it was told to count has gone", async () => {
    const { countPromoUse } = await import("@/lib/promo");
    const survivor = await storedCode({ uses: 3 });

    await countPromoUse(crypto.randomUUID());

    const [after] = await db.select().from(promoCodes).where(eq(promoCodes.id, survivor.id));
    expect(after.uses).toBe(3);
  });
});

describe("the cap, under two customers at once", () => {
  // @characterization — REQ-PRM-011 / REQ-PRM-A01. promo.ts:128-136 documents
  // this as a known and accepted ceiling: the cap is checked when the chair is
  // held and counted when the charge clears, so two people racing the *last*
  // use of a capped code can both redeem it. Nobody is mispriced by it. This
  // pins the behaviour rather than asserting it is right — if the salon ever
  // wants a hard cap, the move is a conditional `update … where uses < max_uses`
  // at hold time, and this test is the one that should then be flipped.
  it("lets two bookings past a cap of one, and leaves it over-used", async () => {
    const { quotePromo, countPromoUse } = await import("@/lib/promo");
    const code = await storedCode({ maxUses: 1, uses: 0 });

    const [first, second] = await Promise.all([
      quotePromo(code.code, 20_000, NOW),
      quotePromo(code.code, 20_000, NOW),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok, "the documented race no longer happens — see REQ-PRM-A01").toBe(true);

    await Promise.all([countPromoUse(code.id), countPromoUse(code.id)]);

    const [after] = await db.select().from(promoCodes).where(eq(promoCodes.id, code.id));
    expect(after.uses).toBe(2);

    // And it shuts behind them: the third customer is refused.
    const third = await quotePromo(code.code, 20_000, NOW);
    expect(third.ok).toBe(false);
    expect((third as { reason: string }).reason).toBe("used-up");
  });
});

// ======================================================= POST /api/promo/quote

describe("POST /api/promo/quote", () => {
  it("answers a refusal with 200 and a reason, not an error", async () => {
    // A typo is not a network failure. A 4xx here shows up in the console on
    // every mistyped code, and the checkout renders the reason either way.
    const { POST } = await import("@/app/api/promo/quote/route");
    const { status, body } = await read(
      await POST(post("http://x/api/promo/quote", { code: "NOSUCHCODE", totalHalalas: 20_000 })),
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("unknown");
  });

  it("prices a live code against the bill it was given", async () => {
    const code = await storedCode({ value: 25 });
    const { POST } = await import("@/app/api/promo/quote/route");
    const { status, body } = await read(
      await POST(post("http://x/api/promo/quote", { code: code.code, totalHalalas: 20_000 })),
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.discountHalalas).toBe(5_000);
    expect(body.totalHalalas).toBe(15_000);
  });

  it("refuses a bill that is not a whole non-negative number of halalas", async () => {
    const { POST } = await import("@/app/api/promo/quote/route");
    for (const totalHalalas of [-1, 1.5, 100_000_01, "20000", null]) {
      const { status } = await read(
        await POST(post("http://x/api/promo/quote", { code: "ANY", totalHalalas })),
      );
      expect(status, `a bill of ${totalHalalas} was accepted`).toBe(400);
    }
  });

  it("refuses an empty code and one longer than any code the salon issues", async () => {
    const { POST } = await import("@/app/api/promo/quote/route");
    for (const code of ["", "   ", "X".repeat(41)]) {
      const { status } = await read(
        await POST(post("http://x/api/promo/quote", { code, totalHalalas: 20_000 })),
      );
      expect(status, `\`${code}\` passed validation`).toBe(400);
    }
    const bad = await read(await POST(post("http://x/api/promo/quote", "{ not json")));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid-json");
  });

  it("throttles a script enumerating the salon's unreleased campaign codes", async () => {
    // Attack: this endpoint distinguishes "unknown" from "expired", so an
    // unthrottled one tells a stranger which guesses are real codes.
    const { POST } = await import("@/app/api/promo/quote/route");
    const ip = "198.51.100.77";
    const seen: number[] = [];
    for (let i = 0; i < 13; i++) {
      const res = await POST(
        post("http://x/api/promo/quote", { code: `GUESS${i}`, totalHalalas: 20_000 }, { ip }),
      );
      seen.push(res.status);
    }
    expect(seen[0]).not.toBe(429);
    expect(seen.filter((s) => s === 429).length, "campaign codes are enumerable").toBeGreaterThan(
      0,
    );
  });

  it("has no wording, in either language, for a code the salon switched off", async () => {
    // The API says `inactive` plainly; the customer must not be able to tell a
    // switched-off code from one that never existed, or the endpoint becomes an
    // oracle for which guesses are real. The screen collapses it to "unknown",
    // and it can only keep doing that while no message exists for it.
    const off = await storedCode({ active: false });
    const { POST } = await import("@/app/api/promo/quote/route");
    const { body } = await read(
      await POST(post("http://x/api/promo/quote", { code: off.code, totalHalalas: 20_000 })),
    );
    expect(body.reason).toBe("inactive");

    const { content } = await import("@/lib/dictionary");
    for (const lang of ["ar", "en"] as const) {
      const errors = (content[lang] as any).payment.promoErrors;
      expect(
        Object.keys(errors),
        `${lang} gained a message that names a switched-off code`,
      ).not.toContain("inactive");
      expect(errors.unknown, `${lang} has no fallback wording for a refused code`).toBeTruthy();
    }
  });
});

// ================================== the charge, where the code is priced again

describe("what the customer is actually charged", () => {
  /** A branch, a service and a signed-up customer, ready to book. */
  async function ready(priceHalalas = 20_000) {
    const branch = await fx.branch({ stationCount: 2 });
    const svc = await fx.service({ priceHalalas, durationMin: 60 });
    const cust = await fx.customer({ verified: true });
    return { branch, svc, cust };
  }

  async function book(
    branchId: string,
    serviceId: string,
    cust: { id: string; phone: string },
    over: Partial<import("@/lib/bookings").CreateBookingsInput> = {},
  ) {
    const { createBookings } = await import("@/lib/bookings");
    return createBookings({
      branchId,
      startsAt: SLOT,
      customer: { phone: cust.phone },
      customerId: cust.id,
      source: "web",
      members: [{ serviceId, addonIds: [] }],
      ...over,
    });
  }

  it("ignores the bill the browser showed and re-prices from the catalogue", async () => {
    // Attack: name your own bill. The quote endpoint will happily say a 25%
    // code is worth 25,000 SAR against a fabricated hundred-thousand-riyal
    // total — and that number reaches nothing that charges anybody.
    const { branch, svc, cust } = await ready(20_000);
    const code = await storedCode({ value: 25 });

    const { POST } = await import("@/app/api/promo/quote/route");
    const { body: preview } = await read(
      await POST(post("http://x/api/promo/quote", { code: code.code, totalHalalas: 100_000_00 })),
    );
    expect(preview.discountHalalas, "the preview refused to price a lie").toBe(2_500_000);

    const made = await book(branch.id, svc.id, cust, { promoCode: code.code });
    await fx.claimBookingsOf(branch.id);
    expect(made.ok).toBe(true);

    const [row] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, (made as { bookings: { id: string }[] }).bookings[0].id));
    // 25% of the catalogue's 200 SAR, not of the browser's hundred thousand.
    expect(row.discountHalalas, "the browser's total reached the charge").toBe(5_000);
    expect(row.totalHalalas).toBe(15_000);
    expect(row.promoCodeId).toBe(code.id);
  });

  it("aborts the whole booking on a refused code rather than charging full price", async () => {
    // Silently charging full price to someone who typed a code is the one
    // outcome nobody would accept — so nothing is written at all.
    const { branch, svc, cust } = await ready();
    const off = await storedCode({ active: false });

    const made = await book(branch.id, svc.id, cust, { promoCode: off.code });
    await fx.claimBookingsOf(branch.id);

    expect(made.ok).toBe(false);
    expect((made as { error: string }).error).toBe("promo-invalid");
    expect((made as { promoReason: string }).promoReason).toBe("inactive");

    const written = await db.select().from(bookings).where(eq(bookings.branchId, branch.id));
    expect(written, "a refused code still left a booking on the books").toHaveLength(0);
  });

  it("carries the minimum back through the booking write, not just the preview", async () => {
    const { branch, svc, cust } = await ready(20_000);
    const code = await storedCode({ minTotalHalalas: 50_000 });

    const made = await book(branch.id, svc.id, cust, { promoCode: code.code });
    await fx.claimBookingsOf(branch.id);

    expect((made as { promoReason: string }).promoReason).toBe("min-total");
    expect((made as { minTotalHalalas: number }).minTotalHalalas).toBe(50_000);
  });

  it("takes the code off after the group discount, and the guests still add up", async () => {
    // §2.10: the promo is an occasion offer, not an alternative to the group
    // discount. Quoted against the combined discounted bill, then shared back
    // out — so the two guests' totals sum to the bill exactly, not to within a
    // halala.
    const { branch, svc, cust } = await ready(25_000);
    const code = await storedCode({ value: 25 });

    const made = await book(branch.id, svc.id, cust, {
      promoCode: code.code,
      members: [
        { serviceId: svc.id, addonIds: [] },
        { serviceId: svc.id, addonIds: [] },
      ],
    });
    await fx.claimBookingsOf(branch.id);
    expect(made.ok).toBe(true);

    const rows = await db.select().from(bookings).where(eq(bookings.branchId, branch.id));
    expect(rows).toHaveLength(2);

    // 2 × 250 SAR, less 10% for booking together, less 25% of what is left.
    const afterGroup = 50_000 - 5_000;
    const promoTook = Math.round(afterGroup * 0.25);
    const billed = rows.reduce((sum, r) => sum + r.totalHalalas, 0);
    expect(billed, "the guests' totals do not add up to the discounted bill").toBe(
      afterGroup - promoTook,
    );
    // Every guest carries a share, and every share is real money off.
    for (const r of rows) {
      expect(r.promoCodeId).toBe(code.id);
      expect(r.discountHalalas).toBeGreaterThan(0);
    }
    expect(rows.reduce((sum, r) => sum + r.discountHalalas, 0)).toBe(50_000 - billed);
  });

  it("freezes what a booking was discounted, however the code is edited later", async () => {
    // History is not allowed to rewrite itself: the campaign the customer
    // booked under is the one on their invoice.
    const { branch, svc, cust } = await ready(20_000);
    const code = await storedCode({ value: 25 });

    const made = await book(branch.id, svc.id, cust, { promoCode: code.code });
    await fx.claimBookingsOf(branch.id);
    const id = (made as { bookings: { id: string }[] }).bookings[0].id;

    await db.update(promoCodes).set({ value: 90 }).where(eq(promoCodes.id, code.id));

    const [row] = await db.select().from(bookings).where(eq(bookings.id, id));
    expect(row.discountHalalas, "editing a live code rewrote an existing bill").toBe(5_000);
    expect(row.totalHalalas).toBe(15_000);
  });

  // @characterization — REQ-PRM-A02 / REQ-STC-009. staff-codes.ts:15 says
  // linking a code to an HR record is "a later phase", so nothing stops a staff
  // code being used by whoever it was forwarded to. Pinned, not endorsed.
  it("lets any customer spend a code that carries a staff member's name", async () => {
    const { branch, svc, cust } = await ready(20_000);
    const member = await fx.staff("technician", branch.id);
    const hers = await storedCode({ value: 90, staffId: member.id, maxUses: 1 });

    const made = await book(branch.id, svc.id, cust, { promoCode: hers.code });
    await fx.claimBookingsOf(branch.id);

    expect(made.ok, "a staff code is an ordinary promo code — see REQ-STC-009").toBe(true);
    const [row] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, (made as { bookings: { id: string }[] }).bookings[0].id));
    expect(row.totalHalalas).toBe(2_000);
  });
});

describe("the admin surface for codes", () => {
  it("offers no way to delete one, because a used code is a money record", async () => {
    // Codes are switched off, never removed: bookings point at them and an
    // invoice has to be able to say which campaign it was written under.
    const actions = await import("@/app/(admin)/admin/(shell)/promo-codes/actions");
    expect(Object.keys(actions).sort()).toEqual(["savePromoCode", "setPromoActive"]);
  });
});
