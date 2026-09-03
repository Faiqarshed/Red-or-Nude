// Both halves of the dictionary, key for key.
//
// `lib/dictionary.ts` types the English object as `typeof ar`, so a missing or
// misspelled key is a compile error. That is a real guard and this file does not
// pretend otherwise — but it is a *compile* guard, and `npm test` never runs
// `tsc`. Four things it cannot see at all:
//
//   • **array length.** `typeof ar.nav` is `{label,href}[]`, which says nothing
//     about how many. Drop a card from `hero.cards` in one language and the
//     types are still satisfied; the screen has a hole in it.
//   • **empty strings.** `""` is a perfectly good `string`.
//   • **placeholders.** `"{n}"` is what turns "that code applies from {n} SAR"
//     into a sentence with a number in it. Lose it in one language and that
//     language quietly stops saying the amount.
//   • **the links.** A nav entry pointing somewhere different depending on the
//     language is two different sites.
//
// Arabic is the primary audience and the site is RTL-first (glossary, "Locales"):
// a missing `ar` string is a blank screen for most customers, not a fallback to
// English. So the comparison below runs in both directions and neither half is
// treated as the authority.

import { describe, expect, it } from "vitest";
import { content } from "@/lib/dictionary";

type Leaf = { path: string; value: string };

/**
 * Every string in the tree, by the path that reaches it. Array indices are part
 * of the path on purpose — that is what makes a dropped card visible.
 */
function leaves(node: unknown, path = ""): Leaf[] {
  if (typeof node === "string") return [{ path, value: node }];
  if (Array.isArray(node)) return node.flatMap((v, i) => leaves(v, `${path}[${i}]`));
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  }
  // Numbers and booleans are not copy; nothing to translate.
  return [];
}

const ar = leaves(content.ar);
const en = leaves(content.en);
const byPath = (rows: Leaf[]) => new Map(rows.map((l) => [l.path, l.value]));
const arByPath = byPath(ar);
const enByPath = byPath(en);

describe("the dictionary has two complete halves", () => {
  it("says something in English everywhere it says something in Arabic", async () => {
    const missing = [...arByPath.keys()].filter((p) => !enByPath.has(p));
    expect(missing, `English is missing ${missing.length} string(s)`).toEqual([]);
  });

  it("says something in Arabic everywhere it says something in English", async () => {
    // The direction that matters most: Arabic is the primary audience, and a
    // missing key there is a blank screen rather than a fallback.
    const missing = [...enByPath.keys()].filter((p) => !arByPath.has(p));
    expect(missing, `Arabic is missing ${missing.length} string(s)`).toEqual([]);
  });

  it("has the same number of cards, links and list items in each language", async () => {
    // Array length is the one shape the type checker cannot hold: an `en`
    // dictionary with two of three cards still satisfies `typeof ar`.
    const lengths = (rows: Leaf[]) => {
      // Every `[n]` in the path, not just the first — a nested list inside a
      // card is still a list whose length has to match.
      const counts = new Map<string, number>();
      for (const { path } of rows) {
        for (const m of path.matchAll(/\[(\d+)\]/g)) {
          const prefix = path.slice(0, m.index);
          counts.set(prefix, Math.max(counts.get(prefix) ?? 0, Number(m[1]) + 1));
        }
      }
      return counts;
    };
    const arLens = lengths(ar);
    const enLens = lengths(en);
    for (const [list, count] of arLens) {
      expect(enLens.get(list), `${list} has ${count} in Arabic and a different number in English`)
        .toBe(count);
    }
    expect([...enLens.keys()].sort()).toEqual([...arLens.keys()].sort());
  });

  it("has no blank string in either language", async () => {
    // A key that exists and says nothing is a missing translation that got past
    // every check that only asks whether the key is there.
    for (const [lang, rows] of [
      ["ar", ar],
      ["en", en],
    ] as const) {
      const blank = rows.filter((l) => l.value.trim() === "").map((l) => l.path);
      expect(blank, `${lang} has ${blank.length} empty string(s)`).toEqual([]);
    }
  });

  it("keeps every placeholder in both halves of the same string", async () => {
    // "{n}" is where the number goes. A sentence that loses it stops saying the
    // amount, in that language only, and reads perfectly well while doing so.
    const tokens = (s: string) => [...s.matchAll(/\{[a-zA-Z0-9_]+\}/g)].map((m) => m[0]).sort();
    const drifted: string[] = [];
    for (const [path, arValue] of arByPath) {
      const enValue = enByPath.get(path);
      if (enValue === undefined) continue;
      const a = tokens(arValue);
      const e = tokens(enValue);
      if (a.join(",") !== e.join(",")) drifted.push(`${path}: ar ${a} vs en ${e}`);
    }
    expect(drifted, "a placeholder exists in one language and not the other").toEqual([]);
  });

  it("points both languages at the same set of pages", async () => {
    // The nav is deliberately reversed in English so it reads correctly
    // left-to-right, so the order is not comparable — the destinations are.
    // A link that differs by language is two different sites.
    const hrefs = (rows: Leaf[]) =>
      rows
        .filter((l) => l.path.endsWith(".href") || l.path.endsWith("href"))
        .map((l) => l.value)
        .sort();
    expect(hrefs(en), "the two languages link to different pages").toEqual(hrefs(ar));
  });

  it("is big enough that these checks are checking something", async () => {
    // A guard against the walker silently returning nothing — every assertion
    // above passes trivially on an empty tree.
    expect(ar.length).toBeGreaterThan(400);
    expect(en.length).toBe(ar.length);
  });
});
