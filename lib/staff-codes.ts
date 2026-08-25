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
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { promoCodes, staff } from "@/lib/db/schema";
import { normalizePromoCode } from "@/lib/promo";

/** The client's number. One place, so raising it is one edit. */
export const STAFF_CODE_PERCENT = 90;

/** First day of the month `date` falls in, and the first day of the next one. */
export function monthWindow(date: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start, end };
}

/**
 * "SARA", "SARA2", "SARA3"… — the first spelling that isn't taken.
 *
 * Names collide in a salon and the code is a unique key, so a second Sara has
 * to get something. Bounded rather than looping forever: after ten tries the
 * name is the problem and a human should pick.
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
  | { ok: true; code: string }
  | { ok: false; reason: "already-issued" | "no-free-code" | "not-found" };

/**
 * Give one staff member their code for the month `date` falls in.
 *
 * Idempotent by design: a member who already has a code inside that window gets
 * nothing new. Both callers depend on that — the button on the staff screen can
 * be pressed twice, and the monthly job can be retried or run twice by a cron
 * that fired late.
 */
export async function issueMonthlyCode(
  staffId: string,
  date: Date = new Date(),
): Promise<IssueOutcome> {
  const { start, end } = monthWindow(date);

  const [member] = await db.select().from(staff).where(eq(staff.id, staffId)).limit(1);
  if (!member) return { ok: false, reason: "not-found" };

  const [existing] = await db
    .select({ code: promoCodes.code })
    .from(promoCodes)
    .where(
      and(
        eq(promoCodes.staffId, staffId),
        gte(promoCodes.startsAt, start),
        lt(promoCodes.startsAt, end),
      ),
    )
    .limit(1);

  if (existing) return { ok: false, reason: "already-issued" };

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

  return { ok: true, code };
}

/**
 * The monthly renewal. Every active staff member, one code each.
 *
 * Nothing deletes last month's — an unused code simply lapses when its window
 * closes, which is exactly what "expires if unused" means, and the row stays as
 * a record of what was offered.
 */
export async function issueMonthlyCodesForEveryone(
  date: Date = new Date(),
): Promise<{ issued: number; skipped: number }> {
  const members = await db.select({ id: staff.id }).from(staff).where(eq(staff.active, true));

  let issued = 0;
  let skipped = 0;
  for (const member of members) {
    const result = await issueMonthlyCode(member.id, date);
    if (result.ok) issued++;
    else skipped++;
  }

  return { issued, skipped };
}
