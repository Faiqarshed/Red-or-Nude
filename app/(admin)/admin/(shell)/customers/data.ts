import "server-only";

// The customers screen's one non-trivial read, split out of page.tsx the way
// front-desk/data.ts and my-day/data.ts are — so it can be tested without
// rendering a page, which is the only reason the bug below went unnoticed.

import { desc, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings } from "@/lib/db/schema";

/** How far back the drawer goes for one customer. */
export const HISTORY_ROWS = 10;

/**
 * The newest {@link HISTORY_ROWS} bookings **per customer**, in one round trip.
 *
 * The first cut of this was a flat `limit(500)` over the whole bookings table
 * with no `where` at all, filtered down to each customer in JS afterwards. That
 * was slower on every render, but the reason it had to change is that it was
 * *wrong*: the 500 newest bookings in the salon are not the 500 newest bookings
 * of the 200 customers on screen. Once the salon was past 500 recent bookings,
 * every customer outside that window rendered with an empty history — a drawer
 * that quietly lies rather than one that visibly truncates, and the kind of
 * thing a receptionist reports as "her appointments are gone".
 *
 * The window does the cut per customer, so one customer's history no longer
 * depends on how busy everybody else has been.
 *
 * Returns an empty array for an empty `ids` — `inArray` with no values is not a
 * query worth sending, and some drivers refuse to build it at all.
 */
export async function recentPerCustomer(ids: string[]) {
  if (ids.length === 0) return [];

  const ranked = db
    .select({
      id: bookings.id,
      customerId: bookings.customerId,
      code: bookings.code,
      startsAt: bookings.startsAt,
      status: bookings.status,
      serviceName: bookings.serviceName,
      totalHalalas: bookings.totalHalalas,
      rank: sql<number>`row_number() over (
        partition by ${bookings.customerId} order by ${bookings.startsAt} desc
      )`.as("rank"),
    })
    .from(bookings)
    .where(inArray(bookings.customerId, ids))
    .as("ranked");

  return db
    .select({
      id: ranked.id,
      customerId: ranked.customerId,
      code: ranked.code,
      startsAt: ranked.startsAt,
      status: ranked.status,
      serviceName: ranked.serviceName,
      totalHalalas: ranked.totalHalalas,
    })
    .from(ranked)
    .where(sql`${ranked.rank} <= ${HISTORY_ROWS}`)
    .orderBy(desc(ranked.startsAt));
}

/** One row of the drawer's list, inferred from the query rather than restated. */
export type CustomerHistoryRow = Awaited<ReturnType<typeof recentPerCustomer>>[number];
