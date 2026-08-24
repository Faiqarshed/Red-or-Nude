// The page the emailed star links open (brief §2.9).
//
// The token is the address — its own random value, not the booking code, which
// gets forwarded and printed on tickets. No lookup form and no login: the
// customer tapped a link sent to the address on file, minutes after an
// appointment we already know they had.

import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, reviews, staff } from "@/lib/db/schema";
import ReviewForm from "./ReviewForm";

export const dynamic = "force-dynamic";

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: { token: string };
  searchParams: { r?: string };
}) {
  const token = decodeURIComponent(params.token).trim();

  const [row] = await db
    .select({
      serviceName: bookings.serviceName,
      startsAt: bookings.startsAt,
      serviceRating: reviews.serviceRating,
      techRating: reviews.techRating,
      comment: reviews.comment,
      submittedAt: reviews.submittedAt,
      // Null today — nothing assigns a technician yet. The join is here rather
      // than a snapshot on the review so the name appears by itself the day
      // assignment lands, including on bookings rated before that.
      technicianName: staff.name,
    })
    .from(reviews)
    .innerJoin(bookings, eq(bookings.id, reviews.bookingId))
    .leftJoin(staff, eq(staff.id, bookings.technicianId))
    .where(eq(reviews.token, token))
    .limit(1);

  if (!row) notFound();

  // `?r=4` from the star the customer clicked in the email. Anything else is
  // ignored rather than rejected — a mangled link should still open the form.
  const preset = Number(searchParams.r);
  const initialRating = Number.isInteger(preset) && preset >= 1 && preset <= 5 ? preset : null;

  return (
    <ReviewForm
      token={token}
      serviceName={row.serviceName}
      startsAt={row.startsAt.toISOString()}
      technicianName={row.technicianName}
      initialRating={initialRating}
      submitted={
        row.submittedAt
          ? {
              serviceRating: row.serviceRating ?? 0,
              techRating: row.techRating,
              comment: row.comment,
            }
          : null
      }
    />
  );
}
