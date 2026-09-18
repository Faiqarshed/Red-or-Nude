import { and, asc, count, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  addons,
  bookingAddons,
  bookings,
  branches,
  customers,
  designs,
  removalTypes,
  reviews,
  services,
  staff,
  stations,
  type Localized,
} from "@/lib/db/schema";
import { addonLineQuery, NO_LINES, splitAddonLines } from "@/lib/admin/addon-lines";
import { mediaUrl } from "@/lib/storage";
import { getSettings } from "@/lib/settings";
import { requirePage } from "@/lib/auth/guard";
import { sweepNoShows } from "@/lib/bookings";
import { can, scopedBranchId } from "@/lib/auth/rbac";
import { halalasToSar } from "@/lib/money";
import { localToUtc, utcToLocalDate } from "@/lib/availability";
import { riyadhDayRange } from "@/lib/time";
import BookingsView, { type BookingRow } from "./BookingsView";
import { partnersElsewhere } from "./partners";

export const dynamic = "force-dynamic";

/** Any priced catalogue row, as the walk-in drawer offers it. */
const toOption = (r: { id: string; name: Localized; priceHalalas: number; durationMin: number }) => ({
  id: r.id,
  name: r.name,
  priceSar: halalasToSar(r.priceHalalas),
  durationMin: r.durationMin,
});

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: { date?: string; branch?: string };
}) {
  const user = await requirePage("bookings.view");

  const branchRows = await db.select().from(branches).orderBy(asc(branches.sort));

  // Admins and receptionists are pinned to their own branch; the CEO chooses.
  const pinned = scopedBranchId(user.role, user.branchId);
  const branchId =
    pinned ?? (searchParams.branch && branchRows.some((b) => b.id === searchParams.branch)
      ? searchParams.branch
      : branchRows[0]?.id);

  const date = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.date ?? "")
    ? searchParams.date!
    : utcToLocalDate(riyadhDayRange().start);

  if (!branchId) {
    return <BookingsView date={date} branches={[]} stations={[]} bookings={[]} noShowCount={0} catalog={{ services: [], addons: [], treats: [], removals: [] }} canManage={false} canSetStatus={false} canReschedule={false} canDelete={false} checkinEarlyMin={0} branchId="" />;
  }

  // Release chairs nobody checked in to, before reading the day back — otherwise
  // the receptionist is looking at a grid that still shows them as occupied.
  await sweepNoShows(branchId);

  const dayStart = localToUtc(date, "00:00");
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  // `getSettings` joins the batch below rather than sitting on its own `await`
  // above it. It depends on nothing here, so as a separate statement it was a
  // whole extra sequential round trip to a database in another region before
  // the first row of the day was even asked for — one of five waves this page
  // used to run through before it could render.
  const [
    { checkin_early_min: checkinEarlyMin },
    stationRows,
    rows,
    [noShowCount],
    addonLinks,
    serviceRows,
    addonRows,
    removalRows,
  ] = await Promise.all([
    getSettings(["checkin_early_min"]),
    db
      .select()
      .from(stations)
      .where(and(eq(stations.branchId, branchId), eq(stations.active, true)))
      .orderBy(asc(stations.sort)),
    db
      .select({
        id: bookings.id,
        code: bookings.code,
        groupId: bookings.groupId,
        startsAt: bookings.startsAt,
        endsAt: bookings.endsAt,
        status: bookings.status,
        // Technician done is not ticket closed — see lib/booking-pulse.ts.
        finishedAt: bookings.finishedAt,
        source: bookings.source,
        stationId: bookings.stationId,
        serviceName: bookings.serviceName,
        totalHalalas: bookings.totalHalalas,
        notes: bookings.notes,
        customerName: sql<string | null>`coalesce(${bookings.customerName}, ${customers.name})`,
        customerPhone: customers.phone,
        // Why this booking is cheaper than the price list says: the code of the
        // booking it refills. A subquery rather than a self-join, because
        // aliasing a self-referencing table defeats Drizzle's type inference.
        refillOfCode: sql<string | null>`(select p.code from bookings p where p.id = bookings.refill_of_booking_id)`,
        noShowNote: bookings.noShowNote,
        // How the appointment actually went. `reviews_booking_unique` means this
        // join can never fan a booking out into two rows, so it costs one join
        // rather than the extra round trip a separate lookup would.
        reviewServiceRating: reviews.serviceRating,
        reviewTechRating: reviews.techRating,
        reviewComment: reviews.comment,
        reviewSubmittedAt: reviews.submittedAt,
        reviewInvitedAt: reviews.invitedAt,
        // The picture, from the live catalogue. `serviceName` above stays the
        // denormalised name-as-sold; only the image follows the catalogue.
        designImage: designs.image,
        serviceImage: services.image,
        // Who is doing it. The front desk knew this all along, from its own
        // per-row dropdown; this screen — the one the CEO and admin actually
        // live on, and the only one that can look at any date or branch — never
        // asked for it, so "who is with whom" was unanswerable from here.
        technicianName: staff.name,
      })
      .from(bookings)
      .leftJoin(customers, eq(bookings.customerId, customers.id))
      .leftJoin(reviews, eq(reviews.bookingId, bookings.id))
      .leftJoin(designs, eq(designs.id, bookings.designId))
      .leftJoin(services, eq(services.id, bookings.serviceId))
      .leftJoin(staff, eq(staff.id, bookings.technicianId))
      .where(
        and(eq(bookings.branchId, branchId), gte(bookings.startsAt, dayStart), lt(bookings.startsAt, dayEnd)),
      )
      .orderBy(asc(bookings.startsAt)),
    // Just how many are outstanding. The rows themselves are /admin/no-shows'
    // job now, and this screen only has to say that the backlog is there.
    //
    // Scoped by role rather than by the branch being browsed, so the figure
    // matches the one on that page: an unresolved flag does not belong to
    // whichever day or branch somebody last clicked.
    db
      .select({ n: count() })
      .from(bookings)
      .where(
        and(
          pinned ? eq(bookings.branchId, pinned) : undefined,
          isNotNull(bookings.noShowAt),
          isNull(bookings.noShowResolvedAt),
        ),
      ),
    // The shared add-on select, scoped here to the day being browsed and run
    // inside this batch rather than after it as a second round trip.
    addonLineQuery()
      .innerJoin(bookings, eq(bookings.id, bookingAddons.bookingId))
      .where(
        and(eq(bookings.branchId, branchId), gte(bookings.startsAt, dayStart), lt(bookings.startsAt, dayEnd)),
      ),
    db.select().from(services).where(eq(services.active, true)).orderBy(asc(services.sort)),
    db.select().from(addons).where(eq(addons.active, true)).orderBy(asc(addons.sort)),
    db.select().from(removalTypes).where(eq(removalTypes.active, true)).orderBy(asc(removalTypes.sort)),
  ]);

  // Guests of this day's parties who chose another branch. Not in `rows`, which
  // is this branch only, and the drawer has to name them anyway.
  const elsewhere = await partnersElsewhere(branchId, rows);

  const lines = splitAddonLines(addonLinks);

  return (
    <BookingsView
      date={date}
      branchId={branchId}
      // Only the CEO chooses. For everyone else `pinned` already decides the
      // query, so offering a picker that changes nothing is a lie.
      branches={pinned ? [] : branchRows.map((b) => ({ id: b.id, name: b.name }))}
      stations={stationRows.map((s) => ({ id: s.id, label: s.label }))}
      canManage={user.role !== "technician"}
      // Rewriting a status by hand is the owner's, and so is moving a booking.
      // Both read the matrix rather than a role list, so they only move once.
      canSetStatus={can(user.role, "bookings.status")}
      // Read from the matrix rather than another role list: this is the one
      // capability the salon has moved, and it should only have to move once.
      canReschedule={can(user.role, "bookings.reschedule")}
      canDelete={can(user.role, "bookings.delete")}
      // So the drawer can say how long until check-in unlocks, rather than only
      // that it hasn't. The setting is the salon's, not the row's, so it travels
      // once instead of on every booking.
      checkinEarlyMin={checkinEarlyMin}
      catalog={{
        services: serviceRows.map(toOption),
        // Split, because to the receptionist a coffee is not an add-on. It is
        // the same `addons` table and the same `addonIds` on the way out —
        // `at_checkout` is the only thing that moves it to its own group.
        addons: addonRows.filter((a) => !a.atCheckout).map(toOption),
        treats: addonRows.filter((a) => a.atCheckout).map(toOption),
        removals: removalRows.map(toOption),
      }}
      noShowCount={noShowCount?.n ?? 0}
      partnersElsewhere={elsewhere}
      branchName={branchRows.find((b) => b.id === branchId)?.name ?? null}
      bookings={rows.map(
        (r): BookingRow => ({
          id: r.id,
          code: r.code,
          groupId: r.groupId,
          startsAt: r.startsAt.toISOString(),
          endsAt: r.endsAt.toISOString(),
          status: r.status,
          finishedAt: r.finishedAt?.toISOString() ?? null,
          source: r.source,
          stationId: r.stationId,
          serviceName: r.serviceName,
          ...(lines.get(r.id) ?? NO_LINES),
          totalSar: halalasToSar(r.totalHalalas),
          notes: r.notes,
          customerName: r.customerName,
          customerPhone: r.customerPhone,
          refillOfCode: r.refillOfCode,
          noShowNote: r.noShowNote,
          imageUrl: mediaUrl(r.designImage ?? r.serviceImage),
          technicianName: r.technicianName,
          // Null means no invitation exists at all — which for a completed
          // booking is worth saying out loud, since one should have been sent.
          review: r.reviewInvitedAt
            ? {
                serviceRating: r.reviewServiceRating,
                techRating: r.reviewTechRating,
                comment: r.reviewComment,
                invitedAt: r.reviewInvitedAt.toISOString(),
                submittedAt: r.reviewSubmittedAt?.toISOString() ?? null,
              }
            : null,
        }),
      )}
    />
  );
}
