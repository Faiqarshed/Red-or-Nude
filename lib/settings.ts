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
