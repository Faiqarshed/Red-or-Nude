// The members of a party who are sitting at another branch.
//
// A group shares one day and nothing else (docs/SCOPE-ENHANCEMENT.md §5.2), so
// one friend at Al Urubah at 14:00 and the other at Al Malqa at 15:00 is one
// booking. Both admin screens read one branch, though — the bookings grid and
// the front desk — so the drawer looked for her friend in a list she was never
// in, and said nothing. "GROUP A" on the block, and no group in the drawer.
//
// Read separately rather than by widening the day's query: those rows are the
// grid, and a booking at another branch has no chair on this one to sit in.

import "server-only";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, branches, customers, type Localized } from "@/lib/db/schema";
import type { BookingStatus } from "./BookingsView";

/** Enough to say who and where. Never opened from here — see BookingDrawer. */
export type PartnerElsewhere = {
  id: string;
  code: string;
  groupId: string;
  startsAt: string;
  status: BookingStatus;
  serviceName: Localized | null;
  customerName: string | null;
  customerPhone: string | null;
  branchName: Localized | null;
};

export async function partnersElsewhere(
  branchId: string,
  rows: { groupId: string | null }[],
): Promise<PartnerElsewhere[]> {
  const groupIds = [...new Set(rows.map((r) => r.groupId).filter((g): g is string => !!g))];
  if (groupIds.length === 0) return [];

  const found = await db
    .select({
      id: bookings.id,
      code: bookings.code,
      groupId: bookings.groupId,
      startsAt: bookings.startsAt,
      status: bookings.status,
      serviceName: bookings.serviceName,
      customerName: sql<string | null>`coalesce(${bookings.customerName}, ${customers.name})`,
      customerPhone: customers.phone,
      branchName: branches.name,
    })
    .from(bookings)
    .leftJoin(customers, eq(customers.id, bookings.customerId))
    .leftJoin(branches, eq(branches.id, bookings.branchId))
    // The same day is already guaranteed by the group; only the branch differs.
    .where(and(inArray(bookings.groupId, groupIds), ne(bookings.branchId, branchId)));

  return found.map((r) => ({ ...r, groupId: r.groupId!, startsAt: r.startsAt.toISOString() }));
}
