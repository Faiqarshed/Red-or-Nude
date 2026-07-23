// Shared by server and client, so it can't live in lib/catalog.ts (server-only).

import type { Localized } from "@/lib/db/schema";
import type { Lang } from "@/lib/i18n";

export type { Localized };

/**
 * Read the active language out of a localized column. Falls back to the other
 * language rather than rendering an empty string — a missing translation should
 * degrade to showing *something*, and the Catalog screen flags it separately.
 */
export function pick(value: Localized | null | undefined, lang: Lang): string {
  if (!value) return "";
  return value[lang] || value.ar || value.en || "";
}
