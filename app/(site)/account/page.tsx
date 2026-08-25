// The account screen (brief §2.8).
//
// A server component, so the signed-out and signed-in states are decided before
// anything renders — no flash of the wrong screen, and the balance and bookings
// arrive with the page rather than after it.

import type { Metadata } from "next";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, services } from "@/lib/db/schema";
import { currentCustomer } from "@/lib/account/guard";
import { loyaltyBalance } from "@/lib/loyalty";
import { claimedWindows } from "@/lib/bookings";
import { halalasToSar } from "@/lib/money";
import { refillDaysLeft } from "@/lib/refill";
import { canCancel, cancelDeadline } from "@/lib/cancellation";
import { getSettings } from "@/lib/settings";
import AccountView from "./AccountView";

export const metadata: Metadata = { title: "Red Or Nude — Account" };

// The session cookie makes this per-request by definition.
export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const customer = await currentCustomer();

  // Signed out: the sign-in form, and nothing else. No booking data is fetched
  // and none is sent.
  if (!customer) return <AccountView />;

  const [balance, rows, { cancel_cutoff_hours: cutoff }] = await Promise.all([
    loyaltyBalance(customer.id),
    // Every booking this customer has, newest first. No reference and no code:
    // the session *is* the credential here, which is the whole reason an account
    // is worth having over /my-bookings.
    db
      .select({
        id: bookings.id,
        code: bookings.code,
        branchId: bookings.branchId,
        startsAt: bookings.startsAt,
        endsAt: bookings.endsAt,
        status: bookings.status,
        ticketNo: bookings.ticketNo,
        serviceName: bookings.serviceName,
        totalHalalas: bookings.totalHalalas,
        refillOfBookingId: bookings.refillOfBookingId,
        refillExpiresAt: bookings.refillExpiresAt,
        refillDays: services.refillDays,
      })
      .from(bookings)
      .leftJoin(services, eq(services.id, bookings.serviceId))
      .where(eq(bookings.customerId, customer.id))
      .orderBy(desc(bookings.startsAt))
      .limit(50),
    getSettings(["cancel_cutoff_hours"]),
  ]);

  const spentOn = await claimedWindows(rows.map((r) => r.id));
  const now = new Date();

  // Shaped exactly like the rows POST /api/my-bookings returns, so the cards
  // render identically on both screens. Same decisions, made in the same place:
  // whether a refill is on offer and whether the cancellation window is still
  // open are the server's call, never the browser's.
  const history = rows.map((r) => {
    const daysLeft = refillDaysLeft(
      {
        startsAt: r.startsAt,
        status: r.status,
        refillDays: r.refillDays ?? 0,
        alreadyRefilled: spentOn.has(r.id),
        isRefill: Boolean(r.refillOfBookingId),
        expiresAt: r.refillExpiresAt,
      },
      now,
    );

    return {
      code: r.code,
      startsAt: r.startsAt.toISOString(),
      status: r.status,
      ticketNo: r.ticketNo,
      serviceName: r.serviceName,
      totalSar: halalasToSar(r.totalHalalas),
      isRefill: Boolean(r.refillOfBookingId),
      hasRefill: daysLeft > 0,
      canCancel: canCancel(r, cutoff, now),
      cancelBy: cancelDeadline(r, cutoff).toISOString(),
      branchId: r.branchId,
      durationMin: Math.round((r.endsAt.getTime() - r.startsAt.getTime()) / 60_000),
    };
  });

  return (
    <AccountView
      customer={{
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        birthday: customer.birthday,
      }}
      balance={balance}
      history={history}
    />
  );
}
