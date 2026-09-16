// Turning a held booking into a confirmed one, by charging for it.
//
// The movie-ticket model: POST /api/bookings puts the chair on hold as `pending`,
// and only a successful charge here flips it to `confirmed` and issues the ticket
// number. An abandoned checkout is swept back out by lib/bookings.ts, so nothing
// has to be cleaned up by hand.
//
// A group is charged once — one gateway transaction — but recorded as one
// `payments` row per booking sharing a `providerRef`. That keeps every row's
// amount equal to its booking's total (so the numbers never lie), while
// SUM(amount) WHERE provider_ref = … is the single combined bill.

import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, payments, staff, stations, type Localized } from "@/lib/db/schema";
import { allocateTickets } from "@/lib/bookings";
import { utcToLocalDate } from "@/lib/availability";
import { notify } from "@/lib/notify";
import { sendBookingInvoice } from "@/lib/invoice/send";
import { countPromoUse } from "@/lib/promo";
import { awardPoints } from "@/lib/loyalty";
import { pointsEarned } from "@/lib/rewards";
import { getSettings } from "@/lib/settings";
import { assignIfToday } from "@/lib/assign";
import { getDriver, type PaymentMethod } from "./index";

export type ConfirmedTicket = {
  code: string;
  ticketNo: string;
  stationLabel: string | null;
  /**
   * Who will be doing it, when that is already known — which for a booking
   * taken for today it is, because assignIfToday ran a few lines before this
   * was built. Null for anything further out: the morning run assigns on the
   * day, so promising a name a week ahead would be promising a guess.
   */
  technicianName: string | null;
  serviceName: Localized | null;
  startsAt: string;
  totalHalalas: number;
};

export type ConfirmResult =
  | { ok: true; tickets: ConfirmedTicket[]; totalHalalas: number }
  | {
      ok: false;
      /**
       * `in-progress` is the one that is not the customer's problem: another tab
       * — or the same button, twice — is already paying for this party. Separate
       * from `expired` because the answer is different. Expired means pick a slot
       * again; this means wait a moment and look at your bookings, because the
       * other attempt is probably about to succeed.
       */
      error: "not-found" | "expired" | "in-progress" | "payment-declined" | "failed";
    };

/**
 * Two taps on Pay, or two tabs. The status read cannot catch it — both see the
 * party pending — so `payments_booking_live_unique` decides which one owns the
 * attempt, and the loser lands here before either has charged anything.
 */
function isLiveAttemptConflict(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    if (e.message.includes("payments_booking_live_unique")) return true;
  }
  return false;
}

export type ConfirmInput = {
  /** Any member's booking code; a group is resolved from it. */
  code: string;
  method: PaymentMethod;
  /** Dev-only, to exercise the decline path. */
  simulate?: "decline";
};

export async function confirmBookingPayment(input: ConfirmInput): Promise<ConfirmResult> {
  const [anchor] = await db
    .select()
    .from(bookings)
    .where(eq(bookings.code, input.code))
    .limit(1);
  if (!anchor) return { ok: false, error: "not-found" };

  // Everyone on this bill. Ordered so tickets are handed out in a stable order.
  const members = anchor.groupId
    ? await db
        .select()
        .from(bookings)
        .where(eq(bookings.groupId, anchor.groupId))
        .orderBy(asc(bookings.createdAt), asc(bookings.id))
    : [anchor];

  // Already swept, already paid, or cancelled — either way there is nothing to
  // charge for and the customer needs to pick a slot again.
  if (members.some((m) => m.status !== "pending")) return { ok: false, error: "expired" };

  const billTotal = members.reduce((sum, m) => sum + m.totalHalalas, 0);
  const driver = getDriver();
  const ref = randomUUID();

  // Bury attempts nobody is still on.
  //
  // Every failure path below flips its row to `failed`, so a declined card
  // retries fine. The one that does not is the process dying mid-charge, or the
  // request being cancelled while the gateway call is in flight: that `pending`
  // row survives, keeps `payments_booking_live_unique` to itself, and every
  // attempt after it is refused as `in-progress` forever — the customer loses a
  // slot whose hold has not even expired. Older than the hold window is the same
  // clock sweepExpiredHolds uses, and past it there is no checkout left to
  // protect.
  //
  // Inside the window she is still refused, deliberately: a charge that died in
  // flight may have landed, and a retry could take the money twice. Do not turn
  // this into an immediate retry without a gateway lookup that can say whether
  // the first attempt settled.
  const { booking_hold_min: holdMin } = await getSettings(["booking_hold_min"]);
  await db
    .update(payments)
    .set({ status: "failed", updatedAt: new Date() })
    .where(
      and(
        inArray(
          payments.bookingId,
          members.map((m) => m.id),
        ),
        eq(payments.status, "pending"),
        lt(payments.createdAt, new Date(Date.now() - holdMin * 60_000)),
      ),
    );

  // Claiming the party, not just recording it.
  //
  // The status read above is the polite check; this is the one that holds. Both
  // halves of a double tap get past that read — it is a read, and nothing stops
  // the other tab between it and here — but only one of them can own the live
  // `payments` row for a booking, because `payments_booking_live_unique` says
  // so. The loser lands in the catch below.
  //
  // Deliberately before the charge. The old order read, charged, and then wrote,
  // so the loser of the race discovered it had lost only after the customer's
  // card had been debited a second time. Nothing here has touched money yet.
  try {
    await db.insert(payments).values(
      members.map((m) => ({
        bookingId: m.id,
        provider: driver.name,
        providerRef: ref,
        method: input.method,
        amountHalalas: m.totalHalalas,
        status: "pending" as const,
      })),
    );
  } catch (err) {
    if (isLiveAttemptConflict(err)) {
      // Somebody is already paying for this party — the other tab, or the same
      // button a moment ago. Not an error the customer caused, and not one a
      // retry should make worse.
      return { ok: false, error: "in-progress" };
    }
    console.error("[payments] could not record the attempt", err);
    return { ok: false, error: "failed" };
  }

  // A bill of nothing never reaches a gateway.
  //
  // A membership credit can cover the whole service line, and a full reward or a
  // 100% code can do the same — in every case there is no money to move, and
  // presenting a real PSP with a zero authorisation is how you collect a decline
  // for a booking that was always going to be free. Worse, the customer was
  // being asked for a card to pay nothing with.
  //
  // The `payments` row above still stands, at zero: it is what
  // `payments_booking_live_unique` keys the double-tap guard on, and a confirmed
  // booking with no payment row at all would be a hole in the day's takings
  // rather than a zero in it.
  let charge;
  if (billTotal === 0) {
    // `ref` carried through rather than left undefined: the update below
    // writes this back onto the row it matches *by* provider_ref, and the
    // refund path keys on the same column. Relying on the driver dropping an
    // undefined key would leave a paid booking with nothing to refund against.
    charge = {
      status: "paid" as const,
      providerRef: ref,
      raw: { free: true, reason: "nothing-to-charge" },
    };
  } else {
    try {
      charge = await driver.charge({
        ref,
        amountHalalas: billTotal,
        method: input.method,
        simulate: input.simulate,
      });
    } catch (err) {
      console.error("[payments] charge threw", err);
      await db
        .update(payments)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(payments.providerRef, ref));
      return { ok: false, error: "failed" };
    }
  }

  if (charge.status !== "paid") {
    // Deliberately leaves the bookings pending: the customer can retry without
    // re-picking their slot, and if they walk away the hold expires on its own.
    await db
      .update(payments)
      .set({ status: "failed", raw: charge.raw, updatedAt: new Date() })
      .where(eq(payments.providerRef, ref));
    return { ok: false, error: "payment-declined" };
  }

  // A party may now sit at more than one branch, and `ticket_counters` is keyed
  // (branch_id, day) — so group the guests by the queue each will actually be
  // standing in. Used twice below: to issue the numbers, and to deal each of
  // those floors afterwards. The same rule createBookings applies to a walk-in,
  // which is confirmed on the spot and so never reaches this file.
  const byQueue = new Map<string, number[]>();
  members.forEach((m, i) => {
    const key = `${m.branchId}:${utcToLocalDate(m.startsAt)}`;
    byQueue.set(key, [...(byQueue.get(key) ?? []), i]);
  });

  // Only the transaction may answer `expired`. This `try` used to cover the reads
  // below it too, so a blip on a station label told a customer whose booking was
  // confirmed, paid and ticketed to go and book it again.
  let tickets: string[];
  try {
    tickets = await db.transaction(async (tx) => {
      await tx
        .update(payments)
        .set({
          status: "paid",
          providerRef: charge.providerRef,
          raw: charge.raw,
          updatedAt: new Date(),
        })
        .where(eq(payments.providerRef, ref));

      // One call per queue, and each run's numbers put back beside the guest
      // who asked for them, so `numbers[i]` still belongs to `members[i]`. A
      // guest at another salon takes that salon's next number rather than one
      // from a queue she will never be standing in.
      const numbers: string[] = new Array(members.length);
      for (const indexes of byQueue.values()) {
        const lead = members[indexes[0]];
        const issued = await allocateTickets(
          tx,
          lead.branchId,
          utcToLocalDate(lead.startsAt),
          indexes.length,
        );
        indexes.forEach((at, k) => (numbers[at] = issued[k]));
      }

      for (const [i, member] of members.entries()) {
        const moved = await tx
          .update(bookings)
          .set({ status: "confirmed", ticketNo: numbers[i], updatedAt: new Date() })
          .where(eq(bookings.id, member.id))
          // Still pending, or someone swept it while the gateway was thinking.
          // The row count is the whole concurrency story here.
          .returning({ id: bookings.id });

        if (moved.length !== 1) throw new Error("hold-expired");
      }

      return numbers;
    });
  } catch (err) {
    // The charge went through but we couldn't confirm. Money was taken for a
    // booking that no longer exists, so this must be loud — a refund is owed.
    console.error(`[payments] charged ${ref} but could not confirm; refund owed`, err);
    return { ok: false, error: "expired" };
  }

  // Past here the booking is real whatever happens. Each of these already
  // swallows its own errors; the wrapper is for the plain reads between them,
  // which had none and do not deserve to be able to unsay a confirmation.
  const labelOf = new Map<string, string>();
  const techOf = new Map<string, string | null>();

  try {
    // Real work on today's floor now, so it gets a technician now. Next week is
    // dawn's job, on the day.
    //
    // One pass per floor the party actually touches. A guest booked at another
    // branch is real work there too, and dealing only the anchor's floor would
    // leave her on nobody's list until the next morning's run.
    for (const indexes of byQueue.values()) {
      const lead = members[indexes[0]];
      await assignIfToday(lead.branchId, lead.startsAt);
    }

    const chairs = await db
      .select({ id: stations.id, label: stations.label })
      .from(stations)
      .where(
        inArray(
          stations.id,
          members.map((m) => m.stationId).filter(Boolean) as string[],
        ),
      );
    for (const c of chairs) labelOf.set(c.id, c.label);

    // Read back rather than taken off `members`: those rows were loaded before
    // assignIfToday ran just above, so a booking taken for today has a
    // technician on the row by now and not in the copy held here. Two readers:
    // the ticket the browser shows and the confirmation message. The invoice
    // looks the same thing up inside buildBookingInvoice, which has callers of
    // its own and should not need one handed in.
    const assigned = await db
      .select({ id: bookings.id, name: staff.name })
      .from(bookings)
      .leftJoin(staff, eq(staff.id, bookings.technicianId))
      .where(
        inArray(
          bookings.id,
          members.map((m) => m.id),
        ),
      );
    for (const r of assigned) techOf.set(r.id, r.name);

    // Two separate messages, on purpose. sendConfirmations is the customer's
    // "you're booked" note and goes through the notify() seam, which is still
    // log-only. sendBookingInvoice is the tax invoice and delivers for real over
    // SMTP. See docs/INVOICE-EMAIL.md §7 — these should almost certainly be one
    // message once notify() has a real driver.
    //
    // Both are awaited rather than fired and forgotten: on a serverless host the
    // function is frozen the moment this response is returned, so a detached
    // promise would simply never finish. Neither can fail the payment — each
    // swallows its own errors and logs.
    // Now, and not at hold time: an abandoned checkout must not spend a use of
    // a limited code. Once per bill — a group is one redemption, not two.
    if (anchor.promoCodeId) await countPromoUse(anchor.promoCodeId);

    // Loyalty points for the bill just paid (brief §2.8). Also at confirmation
    // and for the same reason — an abandoned checkout must not mint points.
    //
    // Note the asymmetry with *spending* points, which happens at hold time in
    // lib/bookings.ts: earning is safe to defer because nothing depends on it
    // yet, whereas a deferred debit could be claimed twice from two tabs.
    //
    // Earned against the bill total, so a group earns once. The row is tied to
    // the anchor booking, which means cancelling it later revokes these points
    // by the same balance filter that returns spent ones.
    if (anchor.customerId) {
      const { loyalty_sar_per_point: sarPerPoint } = await getSettings(["loyalty_sar_per_point"]);
      await awardPoints(anchor.customerId, anchor.id, pointsEarned(billTotal, sarPerPoint));
    }

    await sendConfirmations(members, tickets, labelOf, techOf);
    await sendBookingInvoice(members.map((m) => m.id));
  } catch (err) {
    // She is booked and her ticket is in `tickets`. What failed is a chair label
    // or a receipt, so it is logged and the confirmation still goes back — with
    // whatever the maps above managed to fill in.
    console.error(`[payments] ${ref} confirmed; a step after the commit failed`, err);
  }

  return {
    ok: true,
    totalHalalas: billTotal,
    tickets: members.map((m, i) => ({
      code: m.code,
      ticketNo: tickets[i],
      stationLabel: m.stationId ? (labelOf.get(m.stationId) ?? null) : null,
      technicianName: techOf.get(m.id) ?? null,
      serviceName: m.serviceName,
      startsAt: m.startsAt.toISOString(),
      totalHalalas: m.totalHalalas,
    })),
  };
}

/**
 * The receipt — and, more importantly, how the customer gets their booking
 * reference. That reference is the only key to /my-bookings, so it has to leave
 * the building; the success modal shows it once, this puts it somewhere they can
 * find it again.
 *
 * Awaited but never allowed to fail the confirmation: the money is taken and the
 * chair is theirs whether or not a message provider is having a good day.
 */
async function sendConfirmations(
  members: (typeof bookings.$inferSelect)[],
  tickets: string[],
  labelOf: Map<string, string>,
  techOf: Map<string, string | null>,
): Promise<void> {
  try {
    const customerId = members[0].customerId;
    if (!customerId) return;
    const [customer] = await db
      .select({ email: customers.email, phone: customers.phone, lang: customers.lang })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    if (!customer?.email) return;

    // One message for the whole bill: a pair booked together get one email
    // listing both tickets, not two identical-looking ones.
    await notify({
      channel: "email",
      to: customer.email,
      template: "booking-confirmed",
      lang: customer.lang ?? "ar",
      data: {
        startsAt: members[0].startsAt.toISOString(),
        tickets: members.map((m, i) => ({
          code: m.code,
          ticketNo: tickets[i],
          station: m.stationId ? (labelOf.get(m.stationId) ?? null) : null,
          technician: techOf.get(m.id) ?? null,
          serviceName: m.serviceName,
          totalHalalas: m.totalHalalas,
        })),
      },
    });
  } catch (err) {
    console.error("[payments] confirmation message failed", err);
  }
}
