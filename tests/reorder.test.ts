// reorderBySort — the arrows beside every catalogue row.
//
// Untested until now, and then rewritten from a loop of one UPDATE per row into
// a single CASE statement for speed, which is exactly the kind of change that
// silently renumbers the wrong rows. These are the properties the rewrite had to
// keep, in the order they would hurt if lost:
//
//   • `within` still scopes the write. This is the one the CASE could plausibly
//     break: the add-ons table holds two independent lists (ordinary add-ons and
//     the checkout upsells) and moving a row in one must not touch the other.
//   • duplicate `sort` values still move — the reason the whole column is
//     rewritten rather than two rows swapped.
//   • the no-op cases write nothing at all.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { addons } from "@/lib/db/schema";
import { reorderBySort } from "@/lib/admin/reorder";
import { nameLike } from "./helpers";

/** Marks every row this file creates, so cleanup can never reach a real one. */
const TAG = "zz-reorder-test";

/**
 * `addons.name` is jsonb, so `like` cannot be applied to it directly — Postgres
 * has no `jsonb ~~ text`. Match on the extracted English string instead.
 */
const tagged = nameLike(addons, `%${TAG}%`);

// Both lists are additionally scoped to this file's own rows. The seeded
// catalogue lives in the same table and would otherwise interleave with the
// fixtures, so "the row above b" would sometimes be a real add-on. Narrowing
// `within` is not a workaround — it is the mechanism under test, used exactly
// as CatalogView uses it to keep the two tabs apart.
const ordinary = and(eq(addons.atCheckout, false), tagged)!;
const upsells = and(eq(addons.atCheckout, true), tagged)!;

/** A seeded catalogue row this file never touches, used as a tripwire. */
async function bystander(): Promise<{ id: string; sort: number }> {
  const [row] = await db
    .select({ id: addons.id, sort: addons.sort })
    .from(addons)
    .where(and(eq(addons.atCheckout, false), sql`not (${tagged})`))
    .orderBy(asc(addons.id))
    .limit(1);
  return row;
}

async function seed(
  rows: { label: string; sort: number; atCheckout?: boolean }[],
): Promise<Record<string, string>> {
  const inserted = await db
    .insert(addons)
    .values(
      rows.map((r) => ({
        name: { ar: `${TAG} ${r.label}`, en: `${TAG} ${r.label}` },
        priceHalalas: 0,
        durationMin: 0,
        atCheckout: r.atCheckout ?? false,
        sort: r.sort,
        // Inactive so nothing else in the suite — or the booking pages — can
        // pick these up as real catalogue items while they exist.
        active: false,
      })),
    )
    .returning({ id: addons.id, name: addons.name });

  const byLabel: Record<string, string> = {};
  for (const row of inserted) {
    byLabel[(row.name as { en: string }).en.replace(`${TAG} `, "")] = row.id;
  }
  return byLabel;
}

/** The tagged rows in stored order, as labels. */
async function order(where = ordinary): Promise<string[]> {
  const rows = await db
    .select({ name: addons.name, sort: addons.sort })
    .from(addons)
    .where(and(where, tagged))
    .orderBy(asc(addons.sort), asc(addons.id));
  return rows.map((r) => (r.name as { en: string }).en.replace(`${TAG} `, ""));
}

async function sortsOf(ids: string[]): Promise<number[]> {
  const rows = await db
    .select({ id: addons.id, sort: addons.sort })
    .from(addons)
    .where(inArray(addons.id, ids));
  return ids.map((id) => rows.find((r) => r.id === id)!.sort);
}

beforeEach(async () => {
  await db.delete(addons).where(tagged);
});

afterEach(async () => {
  await db.delete(addons).where(tagged);
});

describe("reorderBySort", () => {
  it("swaps a row with the one below it", async () => {
    const id = await seed([
      { label: "a", sort: 0 },
      { label: "b", sort: 1 },
      { label: "c", sort: 2 },
    ]);

    const moved = await reorderBySort(addons, id.a, "down", ordinary);

    expect(moved).toEqual({ from: 0, to: 1 });
    expect(await order()).toEqual(["b", "a", "c"]);
  });

  it("swaps a row with the one above it", async () => {
    const id = await seed([
      { label: "a", sort: 0 },
      { label: "b", sort: 1 },
      { label: "c", sort: 2 },
    ]);

    const moved = await reorderBySort(addons, id.c, "up", ordinary);

    expect(moved).toEqual({ from: 2, to: 1 });
    expect(await order()).toEqual(["a", "c", "b"]);
  });

  // The reason the implementation rewrites the whole column instead of swapping
  // two numbers: seeded rows often share a sort of 0, and swapping 0 with 0
  // leaves the list looking like the button is broken.
  it("still moves rows that all share the same sort value", async () => {
    const id = await seed([
      { label: "a", sort: 0 },
      { label: "b", sort: 0 },
      { label: "c", sort: 0 },
    ]);

    // Ties break on id, so read the pre-move order rather than assuming a/b/c.
    const before = await order();
    const mover = before[0];

    await reorderBySort(addons, id[mover], "down", ordinary);

    const after = await order();
    expect(after[1]).toBe(mover);
    expect(after).toEqual([before[1], before[0], before[2]]);
    // And the column is left with distinct positions, not three zeroes.
    expect(await sortsOf([id[after[0]], id[after[1]], id[after[2]]])).toEqual([0, 1, 2]);
  });

  // The property most at risk from rewriting this as one statement: the write
  // must be confined to the list the arrows belong to.
  it("leaves the other list in the same table untouched", async () => {
    const id = await seed([
      { label: "a", sort: 0 },
      { label: "b", sort: 1 },
      { label: "hot", sort: 0, atCheckout: true },
      { label: "cold", sort: 1, atCheckout: true },
    ]);

    const upsellSortsBefore = await sortsOf([id.hot, id.cold]);
    const outsider = await bystander();

    await reorderBySort(addons, id.a, "down", ordinary);

    expect(await order(ordinary)).toEqual(["b", "a"]);
    // The upsells neither moved nor were renumbered.
    expect(await order(upsells)).toEqual(["hot", "cold"]);
    expect(await sortsOf([id.hot, id.cold])).toEqual(upsellSortsBefore);
    // Nor did a real catalogue row outside `within` — the CASE renumbers only
    // the ids it was given.
    expect(await sortsOf([outsider.id])).toEqual([outsider.sort]);
  });

  it("moves a row within the upsell list without disturbing the add-ons", async () => {
    const id = await seed([
      { label: "a", sort: 0 },
      { label: "b", sort: 1 },
      { label: "hot", sort: 0, atCheckout: true },
      { label: "cold", sort: 1, atCheckout: true },
    ]);

    await reorderBySort(addons, id.hot, "down", upsells);

    expect(await order(upsells)).toEqual(["cold", "hot"]);
    expect(await order(ordinary)).toEqual(["a", "b"]);
  });

  describe("does nothing, and says so", () => {
    it("refuses to move the first row up", async () => {
      const id = await seed([
        { label: "a", sort: 0 },
        { label: "b", sort: 1 },
      ]);

      expect(await reorderBySort(addons, id.a, "up", ordinary)).toBeNull();
      expect(await sortsOf([id.a, id.b])).toEqual([0, 1]);
    });

    it("refuses to move the last row down", async () => {
      const id = await seed([
        { label: "a", sort: 0 },
        { label: "b", sort: 1 },
      ]);

      expect(await reorderBySort(addons, id.b, "down", ordinary)).toBeNull();
      expect(await sortsOf([id.a, id.b])).toEqual([0, 1]);
    });

    it("refuses an id that is not in the list", async () => {
      const id = await seed([
        { label: "a", sort: 0 },
        { label: "b", sort: 1 },
        { label: "hot", sort: 0, atCheckout: true },
      ]);

      // A real row, but not one of the rows `within` selects — the id-not-found
      // path, reached the way a stale tab would reach it.
      expect(await reorderBySort(addons, id.hot, "down", ordinary)).toBeNull();
      expect(await sortsOf([id.a, id.b])).toEqual([0, 1]);
    });

    it("refuses an id that does not exist at all", async () => {
      const id = await seed([
        { label: "a", sort: 0 },
        { label: "b", sort: 1 },
      ]);

      const absent = "00000000-0000-0000-0000-000000000000";
      expect(await reorderBySort(addons, absent, "down", ordinary)).toBeNull();
      expect(await sortsOf([id.a, id.b])).toEqual([0, 1]);
    });
  });

  it("renumbers a list whose sorts were sparse into consecutive positions", async () => {
    const id = await seed([
      { label: "a", sort: 5 },
      { label: "b", sort: 40 },
      { label: "c", sort: 900 },
    ]);

    await reorderBySort(addons, id.b, "up", ordinary);

    expect(await order()).toEqual(["b", "a", "c"]);
    expect(await sortsOf([id.b, id.a, id.c])).toEqual([0, 1, 2]);
  });
});
