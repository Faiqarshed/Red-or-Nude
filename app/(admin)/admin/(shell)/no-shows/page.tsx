// Bookings nobody checked in to, and what was done about them.
//
// This used to be a strip pinned to the top of /admin/bookings. It is a backlog
// rather than a property of a day — an unresolved flag from Friday has to still
// be there on Monday — so it never belonged to a screen that is scoped to one
// date, and at eighteen rows it pushed the bookings grid off the bottom of the
// page. Its own section, and paginated, because a backlog grows.
//
// Not scoped to the branch being *browsed* either: it follows the role. A
// receptionist and an admin see their own branch, the CEO sees every one, and
// nobody's outstanding flags depend on which day somebody last clicked.
//
// Two tabs, because a resolved flag is still a record worth reading: what the
// salon lost, and what it did about it. Resolving one moves it across rather
// than deleting it from the screen.

import { and, asc, count, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers } from "@/lib/db/schema";
import { requirePage } from "@/lib/auth/guard";
import { can, scopedBranchId } from "@/lib/auth/rbac";
import NoShowsView from "./NoShowsView";

export const dynamic = "force-dynamic";

/** Rows per page. */
const PER_PAGE = 10;

export default async function NoShowsPage({
  searchParams,
}: {
  searchParams: { page?: string; tab?: string };
}) {
  const user = await requirePage("bookings.manage");
  const branchId = scopedBranchId(user.role, user.branchId);

  const tab = searchParams.tab === "resolved" ? "resolved" : "open";

  // Every flag this role can see, whatever became of it.
  const flagged = and(
    isNotNull(bookings.noShowAt),
    branchId ? eq(bookings.branchId, branchId) : undefined,
  );
  const open = and(flagged, isNull(bookings.noShowResolvedAt));
  const resolved = and(flagged, isNotNull(bookings.noShowResolvedAt));

  const asked = Number(searchParams.page);
  const page = Number.isInteger(asked) && asked > 1 ? asked : 1;

  const [[openTotal], [resolvedTotal], rows] = await Promise.all([
    db.select({ n: count() }).from(bookings).where(open),
    db.select({ n: count() }).from(bookings).where(resolved),
    db
      .select({
        id: bookings.id,
        branchId: bookings.branchId,
        startsAt: bookings.startsAt,
        // The reschedule picker keeps the appointment exactly as long as it is.
        endsAt: bookings.endsAt,
        serviceName: bookings.serviceName,
        customerName: customers.name,
        customerPhone: customers.phone,
        noShowNote: bookings.noShowNote,
        noShowResolvedAt: bookings.noShowResolvedAt,
      })
      .from(bookings)
      .leftJoin(customers, eq(bookings.customerId, customers.id))
      .where(tab === "resolved" ? resolved : open)
      // Open: oldest first — the one that has been waiting longest is the one
      // somebody still has to ring. Resolved: newest first, because that list is
      // read as "what happened lately", not worked through.
      .orderBy(tab === "resolved" ? desc(bookings.noShowResolvedAt) : asc(bookings.startsAt))
      .limit(PER_PAGE)
      .offset((page - 1) * PER_PAGE),
  ]);

  return (
    <NoShowsView
      rows={rows.map((r) => ({
        id: r.id,
        branchId: r.branchId,
        startsAt: r.startsAt.toISOString(),
        endsAt: r.endsAt.toISOString(),
        serviceName: r.serviceName,
        customerName: r.customerName,
        customerPhone: r.customerPhone,
        note: r.noShowNote,
        resolvedAt: r.noShowResolvedAt?.toISOString() ?? null,
      }))}
      tab={tab}
      openCount={openTotal?.n ?? 0}
      resolvedCount={resolvedTotal?.n ?? 0}
      page={page}
      perPage={PER_PAGE}
      canReschedule={can(user.role, "bookings.reschedule")}
    />
  );
}
