import "server-only";
import { inArray } from "drizzle-orm";
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
  /** Discount for booking a group together, off the combined bill. */
  group_discount_percent: 10,
  /**
   * What a refill costs, flat, in halalas. Not a discount off the service — the
   * same 99 whether the original was 90 SAR or 400.
   *
   * There is no floor. A service too cheap to be worth refilling at 99 is kept
   * out of the offer from the admin side, by leaving its `refill_days` at 0.
   * That is an operational guard rather than an enforced one: nothing here stops
   * a 60 SAR service being given a window and then a 99 SAR refill.
   */
  refill_price_halalas: 9900,
  /** How many days before a refill window closes to nudge the customer. */
  refill_reminder_days: 3,
  /**
   * The loyalty scheme (brief §2.8), as four numbers the salon can retune
   * without a deploy.
   *
   * **Milestones, not a rate.** The rule the salon asked for is "spend 199 and
   * get 50 points, worth 10 riyals — and 50 more every 200 after that". So the
   * awards land at 199, 399, 599 … and a bill between two thresholds earns what
   * the lower one earned: 350 riyals is still 50 points, because it has not
   * reached 399.
   *
   * This replaced a linear `loyalty_sar_per_point` divisor and a three-rung
   * percentage ladder. Both are gone on purpose. A percentage rung could not
   * answer "what is a point worth" with one number, and a rate could not be
   * stated to a customer as a target she is approaching.
   *
   * Every one of these is whole. `loyalty_point_halalas` is in halalas rather
   * than riyals for the same reason every other money column is: a fractional
   * setting is a float sitting in the middle of a money path waiting to be
   * rounded the wrong way by someone who forgets.
   *
   * At the defaults a customer gets 10 riyals back per 200 spent — about 5%.
   */
  /** Spend that earns the first award, in riyals. */
  loyalty_first_sar: 199,
  /** Every further award costs this much more spend, in riyals. */
  loyalty_step_sar: 200,
  /** Points granted at each milestone, and the unit redemption is counted in. */
  loyalty_step_points: 50,
  /** What one point is worth, in halalas. 20 makes 50 points exactly 10.00 SAR. */
  loyalty_point_halalas: 20,
  /** Seller identity on the invoice. A KSA tax invoice must carry both. */
  business_legal_name: "Red or Nude",
  /** 15 digits from ZATCA. Empty until registration lands; the line is hidden. */
  vat_number: "",
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

/** Read several settings at once, falling back to the defaults above. */
export async function getSettings<K extends SettingKey>(
  keys: K[],
): Promise<{ [P in K]: (typeof SETTING_DEFAULTS)[P] }> {
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, keys as unknown as string[]));

  const out = {} as { [P in K]: (typeof SETTING_DEFAULTS)[P] };
  for (const key of keys) {
    const row = rows.find((r) => r.key === key);
    out[key] = (row?.value ?? SETTING_DEFAULTS[key]) as (typeof SETTING_DEFAULTS)[K];
  }
  return out;
}
