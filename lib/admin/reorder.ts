import "server-only";

// Moving a catalogue row up or down, for any table with a `sort` column.
//
// Lives here rather than in one of the action files because both of them need
// it and a "use server" module may only export server actions — a plain helper
// exported from there would be published as an endpoint taking a table handle,
// which is neither serialisable nor anybody's business.

import { asc, eq, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";

/** Any table this can move a row in. */
type Sortable = PgTable & { id: PgColumn; sort: PgColumn };

/**
 * Swap `id` with its neighbour in `direction`. Returns the positions it moved
 * between, or null when there is no neighbour — the first row asked to go up,
 * or an id that is not in the table. Null is "nothing to do", not a failure.
 *
 * The whole column is rewritten rather than the two rows swapped, because rows
 * seeded with duplicate `sort` values would otherwise swap two identical
 * numbers and appear not to move.
 *
 * `within` narrows what counts as a neighbour, for tables holding more than one
 * list. The add-ons table holds both ordinary add-ons and the checkout upsells,
 * and the admin shows them as two tabs with their own arrows — without this, an
 * upsell moved up would swap `sort` with an ordinary add-on it is not listed
 * beside, and the button would appear to do nothing. Both the read and the
 * rewrite are scoped by it, so the other list keeps its numbering.
 */
export async function reorderBySort(
  table: Sortable,
  id: string,
  direction: "up" | "down",
  within?: SQL,
): Promise<{ from: number; to: number } | null> {
  const rows = await db
    .select({ id: table.id, sort: table.sort })
    .from(table)
    .where(within)
    .orderBy(asc(table.sort), asc(table.id));

  const index = rows.findIndex((r) => r.id === id);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= rows.length) return null;

  const reordered = [...rows];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];

  await db.transaction(async (tx) => {
    for (const [position, row] of reordered.entries()) {
      await tx.update(table).set({ sort: position }).where(eq(table.id, row.id));
    }
  });

  return { from: index, to: target };
}
