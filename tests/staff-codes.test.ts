// A staff member's discount code is hers, not a campaign (client review,
// Sep 2026).
//
// The salon's words: "Staff special discount should be by there id it should be
// seprate from the normal discount page." Both kinds of code have always lived
// in `promo_codes` — which is right, because every rule a staff code needs
// (percent off, one use, a window that lapses) is a rule the promo engine
// already enforces, and a second table would be a second copy of all of them.
//
// What was wrong was the screen. /admin/promo-codes listed every row, so
// "SARA" sat between National Day and Eid, looked like one of them, and could
// be edited like one — dropping her 90% to 10%, or moving the window the
// monthly renewal in lib/staff-codes.ts relies on. Marketing does not own that
// row.
//
// So `staff_id` is now the divider: the marketing page lists only rows without
// one, the staff screen shows each person's own beside her name, and the two
// mutations on the marketing screen refuse a staff row outright — a tab opened
// before the split still holds the id.

import "./as-staff";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { promoCodes, staff } from "@/lib/db/schema";
import {
  STAFF_CODE_PERCENT,
  describeStaffCode,
  issueMonthlyCode,
  monthWindow,
  myStaffCode,
} from "@/lib/staff-codes";

const { savePromoCode, setPromoActive } = await import(
  "@/app/(admin)/admin/(shell)/promo-codes/actions"
);

const WHO = "Zzcodetest";
/** This file's staff rows. Codes are random now, so they are found through these. */
const EMAIL = "zz-code-test@example.invalid";
const EMAIL_2 = "zz-code-test-2@example.invalid";
/** A campaign code of this file's own, for the "still works" half. */
const CAMPAIGN = "ZZCAMPAIGNTEST";

async function wipe() {
  const mine = await db.select({ id: staff.id }).from(staff).where(inArray(staff.email, [EMAIL, EMAIL_2]));
  if (mine.length) {
    await db.delete(promoCodes).where(inArray(promoCodes.staffId, mine.map((m) => m.id)));
    await db.delete(staff).where(inArray(staff.id, mine.map((m) => m.id)));
  }
  await db.delete(promoCodes).where(eq(promoCodes.code, CAMPAIGN));
}

/** One staff member with one freshly issued code. */
async function member(email = EMAIL): Promise<{ staffId: string; codeId: string; code: string }> {
  const [row] = await db
    .insert(staff)
    .values({ name: `${WHO} Alotaibi`, email, role: "technician" })
    .returning({ id: staff.id });

  const issued = await issueMonthlyCode(row.id);
  if (!issued.ok) throw new Error(`setup failed: ${issued.reason}`);

  const [code] = await db.select().from(promoCodes).where(eq(promoCodes.code, issued.code));
  return { staffId: row.id, codeId: code.id, code: issued.code };
}

beforeEach(wipe);
afterAll(wipe);

describe("staff codes are separate from campaign codes", () => {
  it("stamps the code with whose it is", async () => {
    // The whole split hangs off this column. If a code is ever issued without
    // one it reappears on the marketing screen, editable, and nothing else in
    // the app would notice.
    const m = await member();
    const [row] = await db.select().from(promoCodes).where(eq(promoCodes.id, m.codeId));

    expect(row.staffId).toBe(m.staffId);
    expect(row.value).toBe(STAFF_CODE_PERCENT);
    expect(row.maxUses).toBe(1);
  });

  it("refuses to edit a staff code from the marketing screen, and changes nothing", async () => {
    const m = await member();
    const [before] = await db.select().from(promoCodes).where(eq(promoCodes.id, m.codeId));

    const res = await savePromoCode({
      id: m.codeId,
      code: "SOMETHINGELSE",
      // The move that breaks her: 90% quietly becomes a 1 SAR discount.
      type: "fixed",
      value: 1,
      minTotalSar: 0,
      active: false,
    });

    expect(res).toEqual({ ok: false, error: "staff-code" });
    const [after] = await db.select().from(promoCodes).where(eq(promoCodes.id, m.codeId));
    expect(after).toEqual(before);
  });

  it("refuses to switch a staff code off from the marketing screen", async () => {
    const m = await member();

    const res = await setPromoActive(m.codeId, false);

    expect(res).toEqual({ ok: false, error: "staff-code" });
    const [row] = await db.select().from(promoCodes).where(eq(promoCodes.id, m.codeId));
    expect(row.active).toBe(true);
  });

  it("still edits and switches an ordinary campaign code", async () => {
    // The guard has to be about `staff_id` and nothing else. A marketing
    // screen that refused its own codes would be the worse bug.
    const created = await savePromoCode({
      code: CAMPAIGN,
      type: "percent",
      value: 15,
      minTotalSar: 0,
      active: true,
    });
    expect(created.ok).toBe(true);

    const [row] = await db.select().from(promoCodes).where(eq(promoCodes.code, CAMPAIGN));
    expect(row.staffId).toBeNull();

    const edited = await savePromoCode({
      id: row.id,
      code: CAMPAIGN,
      type: "percent",
      value: 25,
      minTotalSar: 0,
      active: true,
    });
    expect(edited.ok).toBe(true);

    const off = await setPromoActive(row.id, false);
    expect(off.ok).toBe(true);

    const [after] = await db.select().from(promoCodes).where(eq(promoCodes.id, row.id));
    expect(after.value).toBe(25);
    expect(after.active).toBe(false);
  });

  it("renews in place, so the code stays hers month after month", async () => {
    // The reason marketing must not move the window: renewal finds *her* row by
    // `staff_id` and slides it forward. A code edited into a different shape is
    // a code the renewal then fights with every month.
    const m = await member();
    const nextMonth = new Date();
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);

    const again = await issueMonthlyCode(m.staffId, nextMonth);

    expect(again).toMatchObject({ ok: true, code: m.code, renewed: true });
    const rows = await db.select().from(promoCodes).where(eq(promoCodes.staffId, m.staffId));
    expect(rows).toHaveLength(1);
    expect(rows[0].uses).toBe(0);
  });
});

describe("a staff code is an id, not her name", () => {
  it("issues a random STF code that does not spell her", async () => {
    // "SARA" is a guess away for anyone who knows who works here, and it is 90%
    // off. The code has to be something only she has been shown.
    const m = await member();

    expect(m.code).toMatch(/^STF[0-9A-F]{8}$/);
    expect(m.code).not.toContain(WHO.toUpperCase());
  });

  it("gives two people with the same first name two different codes", async () => {
    const a = await member(EMAIL);
    const b = await member(EMAIL_2);

    expect(a.code).not.toBe(b.code);
  });

  it("shows her her own code, and nobody else's", async () => {
    const a = await member(EMAIL);
    const b = await member(EMAIL_2);

    expect((await myStaffCode(a.staffId))?.code).toBe(a.code);
    expect((await myStaffCode(b.staffId))?.code).toBe(b.code);
  });

  it("shows nothing to someone who has no code yet", async () => {
    const [row] = await db
      .insert(staff)
      .values({ name: WHO, email: EMAIL, role: "receptionist" })
      .returning({ id: staff.id });

    expect(await myStaffCode(row.id)).toBeNull();
  });

  it("says she has used it once the one use is taken", async () => {
    const m = await member();
    expect((await myStaffCode(m.staffId))?.used).toBe(false);

    await db.update(promoCodes).set({ uses: 1 }).where(eq(promoCodes.id, m.codeId));

    expect((await myStaffCode(m.staffId))?.used).toBe(true);
  });
});

describe("describeStaffCode", () => {
  const now = new Date("2026-09-18T10:00:00.000Z");
  const row = {
    code: "STF0000ABCD",
    value: 90,
    active: true,
    uses: 0,
    endsAt: monthWindow(now).end,
  };

  it("is available until it is used", () => {
    expect(describeStaffCode(row, now)).toMatchObject({ active: true, used: false, percent: 90 });
    expect(describeStaffCode({ ...row, uses: 1 }, now).used).toBe(true);
  });

  it("is off when switched off, whatever the date", () => {
    expect(describeStaffCode({ ...row, active: false }, now).active).toBe(false);
  });

  it("is off the instant its month ends, not a moment after", () => {
    const end = monthWindow(now).end;
    expect(describeStaffCode(row, new Date(end.getTime() - 1)).active).toBe(true);
    expect(describeStaffCode(row, end).active).toBe(false);
  });

  it("renews on the 1st of next month, in Riyadh", () => {
    // Local midnight on 1 October is 21:00 UTC on 30 September. A UTC date
    // would tell her the 30th.
    expect(describeStaffCode(row, now).renewsOn).toBe("2026-10-01");
  });
});
