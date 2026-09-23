// Turning a held booking into a confirmed one, by getting it paid for.
//
// The movie-ticket model: POST /api/bookings puts the chair on hold as `pending`,
// and only a verified payment flips it to `confirmed` and issues the ticket
// number. An abandoned checkout is swept back out by lib/bookings.ts, so nothing
// has to be cleaned up by hand.
//
// Two halves, because a real payment is not an answer but a handoff:
//
//   confirmBookingPayment  claims the party, opens a checkout (a StreamPay link
//                          the page embeds), and returns its URL. With the fake
//                          driver, or a bill of zero, it settles on the spot.
//   settleBookingPayment   asks the gateway what happened and, if it was paid,
//                          confirms. Reached from our return page, the webhook,
//                          the status poll and a retried Pay — often more than
//                          one of them for the same payment, so it is idempotent.
//
// A group is charged once — one gateway transaction — but recorded as one
// `payments` row per booking sharing a `providerRef`. That keeps every row's
// amount equal to its booking's total (so the numbers never lie), while
// SUM(amount) WHERE provider_ref = … is the single combined bill.

import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, payments, staff, stations, type Localized } from "@/lib/db/schema";
import { allocateTickets } from "@/lib/bookings";
import { utcToLocalDate } from "@/lib/availability";
import { notify } from "@/lib/notify";
import { sendBookingInvoice } from "@/lib/invoice/send";
import { countPromoUse } from "@/lib/promo";
import { awardPoints, loyaltyRules } from "@/lib/loyalty";
import { pointsEarned } from "@/lib/rewards";
import { getSettings } from "@/lib/settings";
import { assignIfToday } from "@/lib/assign";
import { siteOrigin } from "@/lib/site";
import { bookingLines } from "./lines";
import { refundRef } from "./refund";
import { checkoutOf, getDriver, mergeRaw, PAY_WINDOW_MIN, type Checkout, type Verdict } from "./index";

export type ConfirmedTicket = {
  code: string;
  ticketNo: string;
  stationLabel: string | null;
  /**
   * Who will be doing it, when that is already known — which for a booking
   * taken for today it is, because assignIfToday ran before this was built.
   * Null for anything further out: the morning run assigns on the day, so
   * promising a name a week ahead would be promising a guess.
   */
  technicianName: string | null;
  serviceName: Localized | null;
  startsAt: string;
  totalHalalas: number;
};

/**
 * `unverified`: StreamPay did not answer "was it paid?". Nothing is known, so
 * nothing is changed — it reads as still pending, and the next check asks again.
 */
export type ConfirmError = "not-found" | "expired" | "in-progress" | "payment-declined" | "failed" | "unverified";

export type ConfirmResult =
  | { ok: true; tickets: ConfirmedTicket[]; totalHalalas: number }
  /** Not paid yet: the page embeds this checkout, then asks /api/payments/status. */
  | { ok: true; checkout: Checkout }
  | {
      ok: false;
      /**
       * `in-progress` is the one that is not the customer's problem: another tab
       * — or the same button, twice — is already paying for this party. Separate
       * from `expired` because the answer is different. Expired means pick a slot
       * again; this means wait a moment and look at your bookings, because the
       * other attempt is probably about to succeed.
       */
      error: ConfirmError;
    };

/**
 * Two taps on Pay, or two tabs. The status read cannot catch it — both see the
 * party pending — so `payments_booking_live_unique` decides which one owns the
 * attempt, and the loser lands here before either has charged anything.
 */
export function isLiveAttemptConflict(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    if (e.message.includes("payments_booking_live_unique")) return true;
  }
  return false;
}

/** A row whose attempt reached a gateway checkout — something verify() can ask about. */
const hasCheckout = (raw: unknown) => Boolean((raw as { linkId?: string } | null)?.linkId);

/** A start that has not reached a checkout by now never will: see confirmBookingPayment. */
const STUCK_START_MS = 2 * 60_000;

export type ConfirmInput = {
  /** Any member's booking code; a group is resolved from it. */
  code: string;
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

  // Everyone on this bill, in a stable order so tickets are handed out consistently.
  const members = anchor.groupId
    ? await db
        .select()
        .from(bookings)
        .where(eq(bookings.groupId, anchor.groupId))
        .orderBy(asc(bookings.createdAt), asc(bookings.id))
    : [anchor];

  if (members.some((m) => m.status !== "pending")) {
    // Already paid: her tickets, not "pick a slot again". She is back here from
    // a second tab, or from Back on her bank's page, and is booked.
    const [paid] = await db
      .select({ ref: payments.providerRef })
      .from(payments)
      .where(and(inArray(payments.bookingId, members.map((m) => m.id)), eq(payments.status, "paid")))
      .limit(1);
    if (paid?.ref && members.every((m) => m.status !== "cancelled" && m.status !== "no_show")) {
      return settleBookingPayment(paid.ref);
    }
    // Swept or cancelled: nothing to charge for, and she needs a slot again.
    return { ok: false, error: "expired" };
  }

  const billTotal = members.reduce((sum, m) => sum + m.totalHalalas, 0);
  const driver = getDriver();
  const { booking_hold_min: holdMin } = await getSettings(["booking_hold_min"]);
  const memberIds = members.map((m) => m.id);

  // An attempt already open for this party: a reload, a second tab, or Pay
  // pressed again after closing the checkout. Asked about before anything new
  // is started, because it may have been paid — and starting a second checkout
  // for a paid party is how she pays twice.
  const [open] = await db
    .select()
    .from(payments)
    .where(and(inArray(payments.bookingId, memberIds), eq(payments.status, "pending")))
    .limit(1);

  if (open?.providerRef && hasCheckout(open.raw)) {
    const outcome = await settleBookingPayment(open.providerRef);
    // Paid (tickets), still open (the same checkout, resumed), or a real error.
    // Only a checkout that is over — declined, expired — falls through to a
    // fresh one; settle has already marked its rows failed.
    if (outcome.ok || outcome.error !== "payment-declined") return outcome;
  } else if (open && Date.now() - open.createdAt.getTime() > STUCK_START_MS) {
    // A row that never got as far as a checkout: the process died mid-charge.
    // Nothing is still running after STUCK_START_MS (each StreamPay call times
    // out at 10 s), so bury it and let her try again, rather than refusing her
    // until her hold runs out. A charge that was only slow, not dead, finds its
    // row buried when it finishes and switches its link off (below).
    // The whole party's rows, not just `open`: one left pending holds
    // payments_booking_live_unique and refuses every retry.
    await db
      .update(payments)
      .set({ status: "failed", updatedAt: new Date() })
      .where(and(inArray(payments.bookingId, memberIds), eq(payments.status, "pending")));
  }

  // A fresh attempt only inside the hold. A checkout already open is given its
  // pay window to finish (PAY_WINDOW_MIN); a new one cannot stretch the hold.
  const heldAt = Math.min(...members.map((m) => m.createdAt.getTime()));
  if (anchor.source === "web" && Date.now() - heldAt > holdMin * 60_000) {
    return { ok: false, error: "expired" };
  }

  const ref = randomUUID();

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
        // What she chose is only known once she has paid; settle overwrites it.
        method: "card" as const,
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
  // for a booking that was always going to be free.
  //
  // The `payments` row above still stands, at zero: it is what
  // `payments_booking_live_unique` keys the double-tap guard on, and a confirmed
  // booking with no payment row at all would be a hole in the day's takings
  // rather than a zero in it.
  if (billTotal === 0) {
    return settleBookingPayment(ref, {
      status: "paid",
      amountHalalas: 0,
      method: "card",
      raw: { free: true, reason: "nothing-to-charge" },
    });
  }

  let charge;
  try {
    const { lines, discounts } = await bookingLines(members);
    const [customer] = anchor.customerId
      ? await db
          .select({ id: customers.id, name: customers.name, phone: customers.phone, email: customers.email })
          .from(customers)
          .where(eq(customers.id, anchor.customerId))
          .limit(1)
      : [];

    charge = await driver.charge({
      ref,
      amountHalalas: billTotal,
      lines,
      discounts,
      title: `Booking ${members.map((m) => m.code).join(", ")}`,
      payer: {
        name: anchor.customerName ?? customer?.name ?? null,
        phone: customer?.phone ?? null,
        email: customer?.email ?? null,
        customerId: customer?.id ?? null,
      },
      expiresAt: new Date(Date.now() + PAY_WINDOW_MIN * 60_000),
      returnUrl: `${siteOrigin()}/api/payments/return?ref=${ref}&back=${encodeURIComponent("/booking/payment")}`,
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

  if (charge.status === "pending") {
    const saved = await db
      .update(payments)
      .set({ raw: charge.raw, updatedAt: new Date() })
      .where(and(eq(payments.providerRef, ref), eq(payments.status, "pending")))
      .returning({ id: payments.id });
    if (saved.length === 0) {
      // Buried as stuck while this charge was still running, and she may have
      // started another since: two payable links for one booking is how she
      // pays twice. This one goes.
      await driver.cancel(charge.raw);
      return { ok: false, error: "failed" };
    }
    return { ok: true, checkout: checkoutOf(ref, charge.raw) ?? { ref, url: charge.checkoutUrl } };
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

  return settleBookingPayment(ref, {
    status: "paid",
    amountHalalas: billTotal,
    method: "card",
    raw: (charge.raw ?? {}) as Record<string, unknown>,
  });
}

/**
 * Confirm the party behind `ref` if — and only if — its payment went through.
 *
 * `known` is the verdict when the caller already has it (the fake driver, a
 * free bill); otherwise the gateway is asked. Never trusts a URL or a webhook
 * body for the answer.
 *
 * Safe to call any number of times, concurrently: the rows are claimed
 * pending → paid inside the confirming transaction, so exactly one caller does
 * the work and the rest read back the tickets it issued.
 */
export async function settleBookingPayment(ref: string, known?: Verdict): Promise<ConfirmResult> {
  const rows = await db.select().from(payments).where(eq(payments.providerRef, ref));
  const bookingIds = rows.map((r) => r.bookingId).filter(Boolean) as string[];
  if (rows.length === 0 || bookingIds.length === 0) return { ok: false, error: "not-found" };

  const members = await db
    .select()
    .from(bookings)
    .where(inArray(bookings.id, bookingIds))
    .orderBy(asc(bookings.createdAt), asc(bookings.id));

  // Somebody else got here first. Tickets if it confirmed, otherwise whatever
  // became of it — a late payment refunded, a declined card.
  if (rows.every((r) => r.status === "paid")) {
    return members.every((m) => m.ticketNo)
      ? { ok: true, tickets: await ticketsOf(members), totalHalalas: sum(members) }
      : { ok: false, error: "expired" };
  }
  if (rows.some((r) => r.status !== "pending")) {
    return { ok: false, error: rows.some((r) => r.status === "failed") ? "payment-declined" : "expired" };
  }

  const driver = getDriver();
  let verdict: Verdict;
  try {
    verdict = known ?? (await driver.verify(rows[0].raw));
  } catch (err) {
    console.error(`[payments] could not verify ${ref}`, err);
    return { ok: false, error: "unverified" };
  }

  if (verdict.status === "pending") {
    const checkout = checkoutOf(ref, rows[0].raw);
    return checkout ? { ok: true, checkout } : { ok: false, error: "in-progress" };
  }

  if (verdict.status === "failed") {
    await db
      .update(payments)
      .set({ status: "failed", updatedAt: new Date() })
      .where(and(eq(payments.providerRef, ref), eq(payments.status, "pending")));
    await driver.cancel(rows[0].raw);
    return { ok: false, error: "payment-declined" };
  }

  const billTotal = rows.reduce((s, r) => s + r.amountHalalas, 0);
  const paid = {
    status: "paid" as const,
    method: verdict.method,
    raw: mergeRaw(payments.raw, verdict.raw),
    updatedAt: new Date(),
  };

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

  try {
    await db.transaction(async (tx) => {
      // The claim. Whoever turns these rows from pending to paid confirms the
      // party; a second settle racing this one finds nothing left to claim.
      const claimed = await tx
        .update(payments)
        .set(paid)
        .where(and(eq(payments.providerRef, ref), eq(payments.status, "pending")))
        .returning({ id: payments.id });
      if (claimed.length === 0) throw new AlreadySettled();

      // It must be the bill we asked for. The link was checked at creation and
      // takes one payment, so this is belt and braces — but it is money.
      if (verdict.amountHalalas !== billTotal) throw new Error("amount-mismatch");

      // Too late to be any use to her: the money came through after her
      // appointment began (a bank that held it for hours, a StreamPay outage).
      // Refunded below rather than confirmed for a time already gone. Only a
      // late payment can get here — the booking flow refuses a time already
      // past — so one settled inside its pay window is left alone.
      const late = Date.now() - rows[0].createdAt.getTime() > PAY_WINDOW_MIN * 60_000;
      if (late && members.some((m) => m.startsAt.getTime() <= Date.now())) throw new Error("started");

      // One call per queue, and each run's numbers put back beside the guest
      // who asked for them, so `numbers[i]` still belongs to `members[i]`.
      const numbers: string[] = new Array(members.length);
      for (const indexes of byQueue.values()) {
        const lead = members[indexes[0]];
        const issued = await allocateTickets(tx, lead.branchId, utcToLocalDate(lead.startsAt), indexes.length);
        indexes.forEach((at, k) => (numbers[at] = issued[k]));
      }

      for (const [i, member] of members.entries()) {
        const moved = await tx
          .update(bookings)
          .set({ status: "confirmed", ticketNo: numbers[i], updatedAt: new Date() })
          // Still pending, or someone swept it while she was paying. The row
          // count is the whole concurrency story here.
          .where(and(eq(bookings.id, member.id), eq(bookings.status, "pending")))
          .returning({ id: bookings.id });

        if (moved.length !== 1) throw new Error("hold-expired");
      }
    });
  } catch (err) {
    if (err instanceof AlreadySettled) return settleBookingPayment(ref);

    // The money is taken and there is no booking to give for it: the hold was
    // swept while she was on her bank's page, or the amount was not the bill.
    // Claimed outside the rolled-back transaction, so only one caller refunds.
    const claimed = await db
      .update(payments)
      .set(paid)
      .where(and(eq(payments.providerRef, ref), eq(payments.status, "pending")))
      .returning({ id: payments.id });
    const why = (err as Error).message;
    if (claimed.length > 0 && why === "amount-mismatch") {
      // Paid a sum that is not the bill. Refunding "the bill" would be the wrong
      // number, so this one is a person's job — loud, with both figures, and
      // marked so the settle job's refund retry leaves it alone.
      await db
        .update(payments)
        .set({ raw: mergeRaw(payments.raw, { amountMismatch: verdict.amountHalalas }) })
        .where(eq(payments.providerRef, ref));
      console.error(
        `[payments] ${ref} paid ${verdict.amountHalalas} for a bill of ${billTotal}; not confirmed. REFUND OWED — settle by hand`,
      );
    } else if (claimed.length > 0 && verdict.amountHalalas > 0) {
      const back = await refundRef(ref, "late-payment");
      console.error(
        `[payments] ${ref} paid but could not confirm (${why}); ` +
          (back.ok ? "auto-refunded" : "REFUND OWED — settle by hand"),
      );
    }
    return { ok: false, error: "expired" };
  }

  const anchor = members[0];

  // Past here the booking is real whatever happens. Each of these already
  // swallows its own errors; the wrapper is for the plain reads between them,
  // which had none and do not deserve to be able to unsay a confirmation.
  let tickets: ConfirmedTicket[] = [];
  try {
    // Real work on today's floor now, so it gets a technician now. Next week is
    // dawn's job, on the day. One pass per floor the party actually touches.
    for (const indexes of byQueue.values()) {
      const lead = members[indexes[0]];
      await assignIfToday(lead.branchId, lead.startsAt);
    }

    tickets = await ticketsOf(members);

    // Now, and not at hold time: an abandoned checkout must not spend a use of
    // a limited code. Once per bill — a group is one redemption, not two.
    if (anchor.promoCodeId) await countPromoUse(anchor.promoCodeId);

    // Loyalty points for the bill just paid (brief §2.8). Also at confirmation
    // and for the same reason — an abandoned checkout must not mint points.
    //
    // Earned against the bill total, so a group earns once. The row is tied to
    // the anchor booking, which means cancelling it later revokes these points
    // by the same balance filter that returns spent ones.
    if (anchor.customerId) {
      // Milestones, not a rate: 199 SAR is 50 points, and so is 350 — the next
      // 50 lands at 399. See lib/rewards.ts milestonesReached.
      await awardPoints(anchor.customerId, anchor.id, pointsEarned(billTotal, await loyaltyRules()));
    }

    // Two separate messages, on purpose. sendConfirmations is the customer's
    // "you're booked" note and goes through the notify() seam, which is still
    // log-only. sendBookingInvoice is the booking confirmation email, linking
    // StreamPay's tax invoice, and delivers for real over SMTP.
    //
    // Both awaited: on a serverless host the function is frozen the moment the
    // response is returned. Neither can fail the payment.
    await sendConfirmations(members, tickets);
    await sendBookingInvoice(members.map((m) => m.id));
  } catch (err) {
    // She is booked. What failed is a chair label or a receipt, so it is logged
    // and the confirmation still goes back — rebuilt if it had not been yet.
    console.error(`[payments] ${ref} confirmed; a step after the commit failed`, err);
    if (tickets.length === 0) tickets = await ticketsOf(members).catch(() => []);
  }

  return { ok: true, tickets, totalHalalas: billTotal };
}

class AlreadySettled extends Error {}

const sum = (members: { totalHalalas: number }[]) => members.reduce((s, m) => s + m.totalHalalas, 0);

/**
 * The tickets as they stand, read fresh: the rows handed in were loaded before
 * the confirmation and before assignIfToday, so neither the number nor the
 * technician is on them yet.
 */
async function ticketsOf(members: (typeof bookings.$inferSelect)[]): Promise<ConfirmedTicket[]> {
  const rows = await db
    .select({
      id: bookings.id,
      ticketNo: bookings.ticketNo,
      stationLabel: stations.label,
      technicianName: staff.name,
    })
    .from(bookings)
    .leftJoin(stations, eq(stations.id, bookings.stationId))
    .leftJoin(staff, eq(staff.id, bookings.technicianId))
    .where(
      inArray(
        bookings.id,
        members.map((m) => m.id),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return members.map((m) => ({
    code: m.code,
    ticketNo: byId.get(m.id)?.ticketNo ?? "",
    stationLabel: byId.get(m.id)?.stationLabel ?? null,
    technicianName: byId.get(m.id)?.technicianName ?? null,
    serviceName: m.serviceName,
    startsAt: m.startsAt.toISOString(),
    totalHalalas: m.totalHalalas,
  }));
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
  tickets: ConfirmedTicket[],
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
        tickets: tickets.map((t) => ({
          code: t.code,
          ticketNo: t.ticketNo,
          station: t.stationLabel,
          technician: t.technicianName,
          serviceName: t.serviceName,
          totalHalalas: t.totalHalalas,
        })),
      },
    });
  } catch (err) {
    console.error("[payments] confirmation message failed", err);
  }
}
