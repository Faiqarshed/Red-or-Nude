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
// Not built, and explicitly a later phase in the brief: linking a code to an HR
// record or a government ID so it cannot be shared.

import "server-only";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { promoCodes, staff } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";
import { normalizePromoCode } from "@/lib/promo";
import { UTC_OFFSET_HOURS } from "@/lib/time";

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

/**
 * "SARA", "SARA2", "SARA3"… — the first spelling that isn't taken.
 *
 * Names collide in a salon and the code is a unique key, so a second Sara has
 * to get something. Bounded rather than looping forever: after ten tries the
 * name is the problem and a human should pick. Only reached for someone's first
 * code; every month after renews that same one.
 */
async function freeCode(base: string): Promise<string | null> {
  const root = normalizePromoCode(base.replace(/[^a-zA-Z0-9]/g, "")) || "STAFF";
  const candidates = ["", 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `${root}${n}`);

  const taken = new Set(
    (
      await db
        .select({ code: promoCodes.code })
        .from(promoCodes)
        .where(inArray(promoCodes.code, candidates))
    ).map((r) => r.code),
  );

  return candidates.find((c) => !taken.has(c)) ?? null;
}

export type IssueOutcome =
  | { ok: true; code: string; renewed: boolean }
  | { ok: false; reason: "already-issued" | "no-free-code" | "not-found" };

/** Who renewal is recorded as in the audit log. */
export const RENEWAL_ACTOR = { id: null, name: "Automatic renewal" } as const;

/**
 * Give one staff member their code for the month `date` falls in.
 *
 * The same code every month: her existing one has its window moved to the new
 * month and its use reset, so "SARA" stays SARA. Last month's bookings keep
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

  // First name only — the brief's example is "Sara", not "Sara Al-Otaibi".
  const code = await freeCode(member.name.trim().split(/\s+/)[0] ?? "");
  if (!code) return { ok: false, reason: "no-free-code" };

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
