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
import { eq, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { promoCodes, staff } from "@/lib/db/schema";
import { STAFF_CODE_PERCENT, issueMonthlyCode } from "@/lib/staff-codes";

const { savePromoCode, setPromoActive } = await import(
  "@/app/(admin)/admin/(shell)/promo-codes/actions"
);

/** Codes generated from this name, so cleanup can never reach a real one. */
const WHO = "Zzcodetest";
const EMAIL = "zz-code-test@example.invalid";
/** A campaign code of this file's own, for the "still works" half. */
const CAMPAIGN = "ZZCAMPAIGNTEST";

async function wipe() {
  await db.delete(promoCodes).where(like(promoCodes.code, `${WHO.toUpperCase()}%`));
  await db.delete(promoCodes).where(eq(promoCodes.code, CAMPAIGN));
  await db.delete(staff).where(eq(staff.email, EMAIL));
}

/** One staff member with one freshly issued code. */
async function member(): Promise<{ staffId: string; codeId: string; code: string }> {
  const [row] = await db
    .insert(staff)
    .values({ name: `${WHO} Alotaibi`, email: EMAIL, role: "technician" })
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
