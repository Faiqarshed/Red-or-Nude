// Per-staff monthly discount codes (brief §3.3).
//
// "Each employee gets a unique code (e.g. 'Sara'), around 90% discount, usable
// once per month, auto-renews each month, expires if unused."
//
// Every one of those rules is already enforced by the promo engine: `value` with
// `type = 'percent'`, `max_uses = 1`, and a `starts_at`/`ends_at` window that
// simply lapses. So a staff code *is* a promo code — the only fact it adds is
// whose it is, which is `promo_codes.staff_id`. No second table, no second set
// of rules to keep in step with lib/promo.ts.
//
// The code itself is random — STF and eight characters — and not her name. A
// name is a guess away for anyone who knows who works here, and a 90% code that
// can be guessed is a 90% code for the whole of Riyadh. It is hers because
// `staff_id` says so, and she reads it off her own screen (MyCodeCard), not
// because it spells her.
//
// Not built, and explicitly a later phase in the brief: linking a code to an HR
// record or a government ID so it cannot be shared.

import "server-only";
import { randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { promoCodes, staff } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";
import { UTC_OFFSET_HOURS, riyadhDateKey } from "@/lib/time";

/** The client's number. One place, so raising it is one edit. */
export const STAFF_CODE_PERCENT = 90;

const OFFSET_MS = UTC_OFFSET_HOURS * 60 * 60 * 1000;

/**
 * The Riyadh calendar month `date` falls in: local midnight on the 1st, to
 * local midnight on the 1st of the next month. A UTC month opened the code at
 * 03:00 on the 1st and left the last three hours of the month on the old one.
 */
export function monthWindow(date: Date): { start: Date; end: Date } {
  const local = new Date(date.getTime() + OFFSET_MS);
  const start = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - OFFSET_MS);
  const end = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - OFFSET_MS);
  return { start, end };
}

/** What a staff code looks like on a screen, from its row and the moment it is read. */
export type StaffCodeView = {
  code: string;
  percent: number;
  /** Both ways a code stops working, as one flag: the switch, and a month that has ended. */
  active: boolean;
  /** `max_uses` is 1, so any use at all is this month spent. */
  used: boolean;
  /** Riyadh date the next month's code opens, `YYYY-MM-DD`. */
  renewsOn: string;
};

/** Shared by the staff list and her own card, so the two can never disagree. */
export function describeStaffCode(
  row: { code: string; value: number; active: boolean; uses: number; endsAt: Date | null },
  now: Date = new Date(),
): StaffCodeView {
  return {
    code: row.code,
    percent: row.value,
    active: row.active && !(row.endsAt && row.endsAt <= now),
    used: row.uses > 0,
    renewsOn: riyadhDateKey(monthWindow(now).end),
  };
}

/** Her current code, or null before the first one has been issued. */
export async function myStaffCode(staffId: string): Promise<StaffCodeView | null> {
  // Newest first: older rows can exist from before codes were renewed in place.
  const [row] = await db
    .select()
    .from(promoCodes)
    .where(eq(promoCodes.staffId, staffId))
    .orderBy(desc(promoCodes.createdAt))
    .limit(1);
  return row ? describeStaffCode(row) : null;
}

export type IssueOutcome =
  | { ok: true; code: string; renewed: boolean }
  | { ok: false; reason: "already-issued" | "not-found" };

/** Who renewal is recorded as in the audit log. */
export const RENEWAL_ACTOR = { id: null, name: "Automatic renewal" } as const;

/**
 * Give one staff member their code for the month `date` falls in.
 *
 * The same code every month: her existing one has its window moved to the new
 * month and its use reset, so the code she knows stays hers. Last month's bookings keep
 * pointing at it, which is where the record of what was used lives.
 *
 * Idempotent by design: a code whose window is already this month is left
 * alone. Both callers depend on that — the monthly job can be retried, run
 * daily, or fired late, and hiring issues one for the month straight away.
 */
export async function issueMonthlyCode(staffId: string, date: Date = new Date()): Promise<IssueOutcome> {
  const { start, end } = monthWindow(date);

  const [member] = await db.select().from(staff).where(eq(staff.id, staffId)).limit(1);
  if (!member) return { ok: false, reason: "not-found" };

  // Newest first: older rows can exist from before codes were renewed in place.
  const [current] = await db
    .select()
    .from(promoCodes)
    .where(eq(promoCodes.staffId, staffId))
    .orderBy(desc(promoCodes.createdAt))
    .limit(1);

  if (current) {
    if (current.startsAt && current.startsAt.getTime() >= start.getTime()) {
      return { ok: false, reason: "already-issued" };
    }
    // Only a person ever switches a code off (an ended month doesn't touch the
    // flag), so an off code stays off: renewal doesn't overrule them.
    const keepOff = !current.active;
    await db
      .update(promoCodes)
      .set({ startsAt: start, endsAt: end, uses: 0, active: !keepOff, updatedAt: new Date() })
      .where(eq(promoCodes.id, current.id));
    await recordAudit(RENEWAL_ACTOR, {
      action: "renew",
      entity: "promo_codes",
      entityId: current.id,
      label: current.code,
      diff: {
        startsAt: { from: current.startsAt?.toISOString() ?? null, to: start.toISOString() },
        uses: { from: current.uses, to: 0 },
        ...(keepOff ? {} : { active: { from: current.active, to: true } }),
      },
    });
    return { ok: true, code: current.code, renewed: true };
  }

  // STF and eight upper-case hex characters: hex has no O or I to misread
  // against 0 and 1 when she reads it out at the desk, and four random bytes
  // only have to be unguessable, since uses are capped at one a month.
  const code = `STF${randomBytes(4).toString("hex").toUpperCase()}`;
  await db.insert(promoCodes).values({
    code,
    staffId,
    type: "percent",
    value: STAFF_CODE_PERCENT,
    maxUses: 1,
    startsAt: start,
    // Exclusive upper bound stored as-is: the promo engine compares against
    // `ends_at`, so a code lapses the instant the next month begins.
    endsAt: end,
    active: true,
  });

  return { ok: true, code, renewed: false };
}

/**
 * The monthly renewal. Every active staff member, one code each.
 *
 * Someone switched off as staff keeps her code as it was: it lapses at the end
 * of its month and is not renewed until she is active again.
 */
export async function issueMonthlyCodesForEveryone(
  date: Date = new Date(),
): Promise<{ issued: number; renewed: number; skipped: number }> {
  const members = await db.select({ id: staff.id }).from(staff).where(eq(staff.active, true));

  let issued = 0;
  let renewed = 0;
  let skipped = 0;
  for (const member of members) {
    const result = await issueMonthlyCode(member.id, date);
    if (!result.ok) skipped++;
    else if (result.renewed) renewed++;
    else issued++;
  }

  return { issued, renewed, skipped };
}
