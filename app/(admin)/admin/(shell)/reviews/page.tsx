// Customer ratings (brief §2.9), read-only — there is nothing here to mutate.
//
// The technician is resolved by a join through the booking rather than stored on
// the review, so a name that gets assigned or corrected after the fact shows up
// on ratings that were left before it. Today nothing assigns one, so the column
// reads "—" and the averages tile says so.

import { avg, count, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, reviews, staff } from "@/lib/db/schema";
import { requirePage } from "@/lib/auth/guard";
import { branchScope } from "@/lib/admin/branch-scope";
import ReviewsView from "./ReviewsView";

export const dynamic = "force-dynamic";

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: { branch?: string };
}) {
  const user = await requirePage("bookings.view");

  // Managers and receptionists see their own branch; owners see everything, or
  // whichever one they have narrowed to — the same helper every screen uses.
  const { branchId: pinned, options: branchOptions } = await branchScope(user, searchParams.branch);

  const rows = await db
    .select({
      id: reviews.id,
      serviceRating: reviews.serviceRating,
      techRating: reviews.techRating,
      comment: reviews.comment,
      invitedAt: reviews.invitedAt,
      submittedAt: reviews.submittedAt,
      serviceName: bookings.serviceName,
      bookingCode: bookings.code,
      startsAt: bookings.startsAt,
      technicianName: staff.name,
    })
    .from(reviews)
    .innerJoin(bookings, eq(bookings.id, reviews.bookingId))
    .leftJoin(staff, eq(staff.id, bookings.technicianId))
    .where(pinned ? eq(bookings.branchId, pinned) : undefined)
    .orderBy(desc(reviews.invitedAt))
    .limit(200);

  // Aggregated in the database over every review, not just the 200 listed above
  // — an average of the most recent page is not the average, and a response rate
  // computed from it is always 100%.
  //
  // `count(column)` counts the non-null ones, which is exactly what "answered",
  // "rated the service" and "rated the technician" each mean here.
  const [totals] = await db
    .select({
      invited: count(),
      answered: count(reviews.submittedAt),
      avgService: avg(reviews.serviceRating),
      avgTech: avg(reviews.techRating),
    })
    .from(reviews)
    .innerJoin(bookings, eq(bookings.id, reviews.bookingId))
    .where(pinned ? eq(bookings.branchId, pinned) : undefined);

  // `avg` comes back as a numeric string, or null when nothing has been rated.
  const num = (value: string | null) => (value === null ? null : Number(value));

  return (
    <ReviewsView
      branchId={pinned}
      branchOptions={branchOptions}
      invited={totals?.invited ?? 0}
      answered={totals?.answered ?? 0}
      avgService={num(totals?.avgService ?? null)}
      avgTech={num(totals?.avgTech ?? null)}
      rows={rows.map((r) => ({
        id: r.id,
        serviceRating: r.serviceRating,
        techRating: r.techRating,
        comment: r.comment,
        submittedAt: r.submittedAt?.toISOString() ?? null,
        invitedAt: r.invitedAt.toISOString(),
        serviceName: r.serviceName,
        bookingCode: r.bookingCode,
        startsAt: r.startsAt.toISOString(),
        technicianName: r.technicianName,
      }))}
    />
  );
}
