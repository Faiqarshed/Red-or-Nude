// The in-service add-on page (brief §2.7) — what a station's QR sticker opens.
//
// A customer already in the chair scans the code on their table and is asked one
// question: is this same chair still free when I finish? Everything needed to
// answer it is here, on the server:
//
//   1. the token identifies the chair (never the row id — see lib/db/schema.ts)
//   2. the booking currently running on it gives the projected finish time
//   3. stationFreeWindow() gives how long the chair stays free after that
//
// If there is a gap, the services that fit inside it are offered and checkout is
// the ordinary one: /booking/payment → POST /api/bookings → POST
// /api/payments/confirm, which issues a second ticket number on the same chair.
// If there is no gap, the page says so and sends them to /booking, where the
// engine will find them a different free station — exactly the fallback the
// brief describes.

import { notFound } from "next/navigation";
import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { bookings, branches, customers, stations } from "@/lib/db/schema";
import { getPublicCatalog } from "@/lib/catalog";
import { stationFreeWindow } from "@/lib/availability";
import StationAddOnView from "./StationAddOnView";

export const dynamic = "force-dynamic";

export default async function StationPage({ params }: { params: { token: string } }) {
  // The token is a uuid column; anything else cannot match, and letting a
  // malformed one reach the query would be a 500 where a 404 is the truth.
  if (!z.string().uuid().safeParse(params.token).success) notFound();

  const [station] = await db
    .select({
      id: stations.id,
      label: stations.label,
      branchId: stations.branchId,
      branchName: branches.name,
    })
    .from(stations)
    .innerJoin(branches, eq(branches.id, stations.branchId))
    .where(and(eq(stations.qrToken, params.token), eq(stations.active, true)))
    .limit(1);

  // Unknown token, or a chair the salon has retired. Both are "this sticker is
  // not a thing" as far as the customer is concerned.
  if (!station) notFound();

  const now = new Date();

  // Who is in the chair right now. `in_progress` is the receptionist having
  // pressed Start; `confirmed` covers the far more common case of nobody having
  // got round to it — the customer is sitting there either way.
  const [current] = await db
    .select({
      code: bookings.code,
      endsAt: bookings.endsAt,
      serviceName: bookings.serviceName,
      customerName: customers.name,
    })
    .from(bookings)
    .leftJoin(customers, eq(customers.id, bookings.customerId))
    .where(
      and(
        eq(bookings.stationId, station.id),
        inArray(bookings.status, ["confirmed", "in_progress"]),
        lte(bookings.startsAt, now),
        gt(bookings.endsAt, now),
      ),
    )
    .orderBy(asc(bookings.startsAt))
    .limit(1);

  // The projected finish time from the brief. With nobody in the chair the
  // scanner is standing at an empty table, and "now" is the honest answer —
  // the same page then works as a walk-up rather than erroring.
  const startsAt = current?.endsAt ?? now;
  const [freeMin, catalog] = await Promise.all([
    stationFreeWindow(station.branchId, station.id, startsAt),
    getPublicCatalog(),
  ]);

  return (
    <StationAddOnView
      station={{ label: station.label, branchId: station.branchId, token: params.token }}
      branchName={station.branchName}
      startsAt={startsAt.toISOString()}
      freeMin={freeMin}
      inService={Boolean(current)}
      currentServiceName={current?.serviceName ?? null}
      customerName={current?.customerName ?? null}
      // Only the services fit in the gap. Filtered on the server so the page
      // cannot offer a 90-minute set into a 40-minute window and take payment
      // for something reserveStations would then refuse.
      services={catalog.services.filter((s) => s.durationMin <= freeMin)}
    />
  );
}
