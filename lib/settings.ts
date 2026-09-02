import "server-only";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";

export const SETTING_DEFAULTS = {
  vat_percent: 15,
  slot_length_min: 30,
  /**
   * Minutes of notice a *customer* must give on a new or moved booking.
   *
   * Zero: book the chair you can see. The 60 that used to sit here was a
   * developer's default that nothing in the brief ever asked for, and it was
   * quietly costing the salon the next two slots on a floor with every chair
   * free — the picker struck them through, so they read as fully booked.
   *
   * The machinery stays: raise this and lib/availability marks the slots inside
   * the window `too-soon`, and the picker explains the rule instead of pretending
   * the salon is busy. Staff are exempt either way (see the walkIn parameter).
   */
  booking_lead_time_min: 0,
  currency: "SAR",
  timezone: "Asia/Riyadh",
  /** How long an unpaid web booking holds its chair before it's swept. */
  booking_hold_min: 15,
  /** How close to the appointment a customer may still cancel or move it. */
  cancel_cutoff_hours: 3,
  /** How long a paid booking waits to be checked in before its chair is released. */
  no_show_grace_min: 20,
  /**
   * How many minutes before her slot a customer may be checked in.
   *
   * Zero means not before it at all. Checking someone in early does more than
   * skew a number: pickTechnician() counts a checked-in booking as busy, so an
   * early arrival takes her technician off the floor until she is actually
   * served, while customers who *are* due are told nobody is free.
   */
  checkin_early_min: 0,
  /**
   * How long before her slot the assigned technician is emailed.
   *
   * The reminder job runs every quarter hour and mails anyone starting inside
   * this window, once. Set it shorter than the gap between runs and appointments
   * will be missed, so keep it comfortably above 15.
   */
  assign_notify_min: 30,
  /** Discount for booking two guests together, off the combined bill. */
  group_discount_percent: 10,
  /** A refill costs the service price minus this much. */
  refill_discount_percent: 50,
  /** How many days before a refill window closes to nudge the customer. */
  refill_reminder_days: 3,
  /**
   * How many riyals earn one loyalty point (brief §2.8).
   *
   * A **divisor**, not a multiplier, and deliberately so. Points are whole
   * numbers — an integer column, an integer balance, integers on screen — so
   * the only way to earn less than a point per riyal with a multiplier is a
   * fractional setting like 0.2, and a fractional setting is a float sitting in
   * the middle of a money path waiting to be rounded the wrong way by someone
   * who forgets. Dividing by an integer cannot produce one.
   *
   * What a point is *worth* is the reward ladder in lib/loyalty.ts, not a number
   * here — a rung is a percentage off, so there is no single exchange rate.
   *
   * At 5, a 150 SAR visit earns 30 points and the first rung (100 points, 5%
   * off) lands after roughly 500 SAR of custom — about 1.5% back. Raise this to
   * be stingier, lower it to be generous; it is the one knob for the whole
   * scheme and it needs no deploy.
   */
  loyalty_sar_per_point: 5,
  /** Seller identity on the invoice. A KSA tax invoice must carry both. */
  business_legal_name: "Red or Nude",
  /** 15 digits from ZATCA. Empty until registration lands; the line is hidden. */
  vat_number: "",
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

/**
 * Every stored setting, cached in the process for a minute.
 *
 * The whole table, not the keys asked for. It is about twenty rows and it is
 * read on nearly every request — often three or four times in one render, by a
 * page, its data loader and sweepNoShows, each asking for different keys and so
 * each paying its own round trip. Neon's query insights had this at 245 calls
 * across a short session: every one of them 0ms of database work and a full
 * trip to Frankfurt.
 *
 * A plain map rather than `unstable_cache`, deliberately. next/cache reaches
 * into React's server-only build, which throws the moment anything outside the
 * Next runtime imports it — and half of scripts/check-*.ts reaches this file
 * through lib/bookings. A framework-free cache keeps the test suite runnable
 * and costs four lines.
 *
 * ponytail: per-instance and lost on cold start, exactly like lib/throttle.ts.
 * Nothing writes this table outside the seed, so the only staleness is a
 * hand-edited row taking up to a minute to land.
 */
const TTL_MS = 60_000;
let cache: { rows: { key: string; value: unknown }[]; at: number } | null = null;

async function loadSettings() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const rows = await db.select().from(settings);
  cache = { rows, at: Date.now() };
  return rows;
}

/**
 * Merge stored rows over the defaults. Pure, so the fallback rule — which is
 * what stops a missing row reading as zero VAT — is checkable without a
 * database. See scripts/check-fields.ts.
 */
export function pickSettings<K extends SettingKey>(
  rows: { key: string; value: unknown }[],
  keys: K[],
): { [P in K]: (typeof SETTING_DEFAULTS)[P] } {
  const out = {} as { [P in K]: (typeof SETTING_DEFAULTS)[P] };
  for (const key of keys) {
    const row = rows.find((r) => r.key === key);
    out[key] = (row?.value ?? SETTING_DEFAULTS[key]) as (typeof SETTING_DEFAULTS)[K];
  }
  return out;
}

/** Read several settings at once, falling back to the defaults above. */
export async function getSettings<K extends SettingKey>(
  keys: K[],
): Promise<{ [P in K]: (typeof SETTING_DEFAULTS)[P] }> {
  return pickSettings(await loadSettings(), keys);
}
