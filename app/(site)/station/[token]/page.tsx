// The in-service add-on page (brief §2.7) — what a station's QR sticker opens.
//
// A customer already in the chair scans the code on their table and is asking
// one thing: can I have another service when this one ends? The page answers it
// in that order — this chair first, then the rest of the room:
//
//   1. the token identifies the chair (never the row id — see lib/db/schema.ts)
//   2. the booking currently running on it gives the projected finish time
//   3. stationFreeWindow() gives how long each chair stays free after that
//
// Every active chair in the branch is measured, not just the scanned one, so a
// chair that is booked straight after does not dead-end the customer: the same
// page offers the tables that *are* free at that moment and books one of them.
// Checkout is the ordinary one either way — /booking/payment → POST
// /api/bookings → POST /api/payments/confirm — with the chosen chair's own qr
// token pinning the booking to it.

import { notFound } from "next/navigation";
import { and, asc, eq, gt, inArray, lte, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { bookings, branches, customers, stations } from "@/lib/db/schema";
import { getPublicCatalog } from "@/lib/catalog";
import { offerableStations, stationFreeWindow } from "@/lib/availability";
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

  // Every active chair here, the scanned one first so it is always the option
  // the customer is offered before any alternative.
  const [siblings, catalog] = await Promise.all([
    db
      .select({ id: stations.id, label: stations.label, token: stations.qrToken })
      .from(stations)
      .where(
        and(
          eq(stations.branchId, station.branchId),
          eq(stations.active, true),
          ne(stations.id, station.id),
        ),
      )
      .orderBy(asc(stations.sort), asc(stations.label)),
    getPublicCatalog(),
  ]);

  const room = [{ id: station.id, label: station.label, token: params.token }, ...siblings];

  // ponytail: one stationFreeWindow() per chair rather than one query over all
  // of them — a branch is a handful of chairs and these run in parallel, so it
  // is a single round trip's latency. Fold it into one query if a branch ever
  // grows past a few dozen stations.
  const windows = await Promise.all(
    room.map((s) => stationFreeWindow(station.branchId, s.id, startsAt)),
  );

  // Which chairs are worth offering, scanned one first. Decided on the server so
  // the page cannot offer a chair reserveStations would then refuse to hold.
  const options = offerableStations(
    room,
    windows,
    station.id,
    Math.min(...catalog.services.map((s) => s.durationMin)),
  );

  return (
    <StationAddOnView
      branchId={station.branchId}
      branchName={station.branchName}
      scannedLabel={station.label}
      startsAt={startsAt.toISOString()}
      inService={Boolean(current)}
      currentServiceName={current?.serviceName ?? null}
      customerName={current?.customerName ?? null}
      options={options}
      services={catalog.services}
    />
  );
}
