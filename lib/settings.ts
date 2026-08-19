import "server-only";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";

export const SETTING_DEFAULTS = {
  vat_percent: 15,
  slot_length_min: 30,
  booking_lead_time_min: 60,
  currency: "SAR",
  timezone: "Asia/Riyadh",
  /** How long an unpaid web booking holds its chair before it's swept. */
  booking_hold_min: 15,
  /** How close to the appointment a customer may still cancel or move it. */
  cancel_cutoff_hours: 3,
  /** Discount for booking two guests together, off the combined bill. */
  group_discount_percent: 10,
  /** A refill costs the service price minus this much. */
  refill_discount_percent: 50,
  /** How many days before a refill window closes to nudge the customer. */
  refill_reminder_days: 3,
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
