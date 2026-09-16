// Shared by server and client, so it can't live in lib/catalog.ts (server-only).

import type { Localized } from "@/lib/db/schema";
import type { Lang } from "@/lib/i18n";

export type { Localized };

/**
 * The language cookie. Here, not in lib/i18n.tsx: that file is "use client", and
 * a value imported from one into a server component arrives as a client
 * reference rather than the string — the layout would read a cookie named
 * nothing, and always render Arabic.
 */
export const LANG_COOKIE = "ron-lang";

/**
 * Read the active language out of a localized column. Falls back to the other
 * language rather than rendering an empty string — a missing translation should
 * degrade to showing *something*, and the Catalog screen flags it separately.
 */
export function pick(value: Localized | null | undefined, lang: Lang): string {
  if (!value) return "";
  return value[lang] || value.ar || value.en || "";
}
