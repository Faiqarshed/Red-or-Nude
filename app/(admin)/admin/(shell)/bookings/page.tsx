import { and, asc, eq, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  addons,
  bookingAddons,
  bookings,
  branches,
  customers,
  removalTypes,
  reviews,
  services,
  stations,
} from "@/lib/db/schema";
import { requirePage } from "@/lib/auth/guard";
import { sweepNoShows } from "@/lib/bookings";
import { scopedBranchId } from "@/lib/auth/rbac";
import { halalasToSar } from "@/lib/money";
import { localToUtc, utcToLocalDate } from "@/lib/availability";
import { riyadhDayRange } from "@/lib/time";
import BookingsView, { type BookingRow } from "./BookingsView";

export const dynamic = "force-dynamic";

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
    return <BookingsView date={date} branches={[]} stations={[]} bookings={[]} noShows={[]} catalog={{ services: [], addons: [], removals: [] }} canManage={false} branchId="" />;
  }

  // Release chairs nobody checked in to, before reading the day back — otherwise
  // the receptionist is looking at a grid that still shows them as occupied.
  await sweepNoShows(branchId);

  const dayStart = localToUtc(date, "00:00");
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const [stationRows, rows, noShowRows, addonLinks, serviceRows, addonRows, removalRows] = await Promise.all([
    db
      .select()
      .from(stations)
      .where(and(eq(stations.branchId, branchId), eq(stations.active, true)))
      .orderBy(asc(stations.sort)),
    db
      .select({
        id: bookings.id,
        code: bookings.code,
        startsAt: bookings.startsAt,
        endsAt: bookings.endsAt,
        status: bookings.status,
        source: bookings.source,
        stationId: bookings.stationId,
        serviceName: bookings.serviceName,
        totalHalalas: bookings.totalHalalas,
        notes: bookings.notes,
        customerName: customers.name,
        customerPhone: customers.phone,
        // Why this booking is cheaper than the price list says.
        refillOfBookingId: bookings.refillOfBookingId,
        refillExpiresAt: bookings.refillExpiresAt,
        noShowNote: bookings.noShowNote,
        // How the appointment actually went. `reviews_booking_unique` means this
        // join can never fan a booking out into two rows, so it costs one join
        // rather than the extra round trip a separate lookup would.
        reviewServiceRating: reviews.serviceRating,
        reviewTechRating: reviews.techRating,
        reviewComment: reviews.comment,
        reviewSubmittedAt: reviews.submittedAt,
        reviewInvitedAt: reviews.invitedAt,
      })
      .from(bookings)
      .leftJoin(customers, eq(bookings.customerId, customers.id))
      .leftJoin(reviews, eq(reviews.bookingId, bookings.id))
      .where(
        and(eq(bookings.branchId, branchId), gte(bookings.startsAt, dayStart), lt(bookings.startsAt, dayEnd)),
      )
      .orderBy(asc(bookings.startsAt)),
    // Every unresolved flag for this branch, on any date — the strip is not
    // scoped to the day being viewed, or a Friday no-show would vanish the
    // moment someone clicked to Monday.
    db
      .select({
        id: bookings.id,
        startsAt: bookings.startsAt,
        serviceName: bookings.serviceName,
        customerName: customers.name,
        customerPhone: customers.phone,
      })
      .from(bookings)
      .leftJoin(customers, eq(bookings.customerId, customers.id))
      .where(
        and(
          eq(bookings.branchId, branchId),
          isNotNull(bookings.noShowAt),
          isNull(bookings.noShowResolvedAt),
        ),
      )
      .orderBy(asc(bookings.startsAt)),
    db
      .select({ bookingId: bookingAddons.bookingId, name: bookingAddons.name })
      .from(bookingAddons),
    db.select().from(services).where(eq(services.active, true)).orderBy(asc(services.sort)),
    db.select().from(addons).where(eq(addons.active, true)).orderBy(asc(addons.sort)),
    db.select().from(removalTypes).where(eq(removalTypes.active, true)).orderBy(asc(removalTypes.sort)),
  ]);

  // Resolve the parent reference of any refills on this day. A self-join would
  // do it in one query, but aliasing a self-referencing table defeats Drizzle's
  // type inference — and one extra lookup over a single day's bookings is free.
  const parentIds = rows.map((r) => r.refillOfBookingId).filter(Boolean) as string[];
  const parentCodes = new Map(
    parentIds.length
      ? (
          await db
            .select({ id: bookings.id, code: bookings.code })
            .from(bookings)
            .where(inArray(bookings.id, parentIds))
        ).map((p) => [p.id, p.code])
      : [],
  );

  const addonsByBooking = new Map<string, { ar: string; en: string }[]>();
  for (const link of addonLinks) {
    if (!link.name) continue;
    const list = addonsByBooking.get(link.bookingId) ?? [];
    list.push(link.name);
    addonsByBooking.set(link.bookingId, list);
  }

  return (
    <BookingsView
      date={date}
      branchId={branchId}
      // Only the CEO chooses. For everyone else `pinned` already decides the
      // query, so offering a picker that changes nothing is a lie.
      branches={pinned ? [] : branchRows.map((b) => ({ id: b.id, name: b.name }))}
      stations={stationRows.map((s) => ({ id: s.id, label: s.label }))}
      canManage={user.role !== "technician"}
      catalog={{
        services: serviceRows.map((s) => ({
          id: s.id,
          name: s.name,
          priceSar: halalasToSar(s.priceHalalas),
          durationMin: s.durationMin,
        })),
        addons: addonRows.map((a) => ({
          id: a.id,
          name: a.name,
          priceSar: halalasToSar(a.priceHalalas),
          durationMin: a.durationMin,
        })),
        removals: removalRows.map((r) => ({
          id: r.id,
          name: r.name,
          priceSar: halalasToSar(r.priceHalalas),
          durationMin: r.durationMin,
        })),
      }}
      noShows={noShowRows.map((r) => ({
        id: r.id,
        startsAt: r.startsAt.toISOString(),
        serviceName: r.serviceName,
        customerName: r.customerName,
        customerPhone: r.customerPhone,
      }))}
      bookings={rows.map(
        (r): BookingRow => ({
          id: r.id,
          code: r.code,
          startsAt: r.startsAt.toISOString(),
          endsAt: r.endsAt.toISOString(),
          status: r.status,
          source: r.source,
          stationId: r.stationId,
          serviceName: r.serviceName,
          addons: addonsByBooking.get(r.id) ?? [],
          totalSar: halalasToSar(r.totalHalalas),
          notes: r.notes,
          customerName: r.customerName,
          customerPhone: r.customerPhone,
          refillOfCode: r.refillOfBookingId ? (parentCodes.get(r.refillOfBookingId) ?? null) : null,
          refillExpiresAt: r.refillExpiresAt?.toISOString() ?? null,
          noShowNote: r.noShowNote,
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
