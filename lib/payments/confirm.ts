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
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, payments, stations, type Localized } from "@/lib/db/schema";
import { allocateTickets } from "@/lib/bookings";
import { utcToLocalDate } from "@/lib/availability";
import { notify } from "@/lib/notify";
import { sendBookingInvoice } from "@/lib/invoice/send";
import { getDriver, type PaymentMethod } from "./index";

export type ConfirmedTicket = {
  code: string;
  ticketNo: string;
  stationLabel: string | null;
  serviceName: Localized | null;
  startsAt: string;
  totalHalalas: number;
};

export type ConfirmResult =
  | { ok: true; tickets: ConfirmedTicket[]; totalHalalas: number }
  | { ok: false; error: "not-found" | "expired" | "payment-declined" | "failed" };

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

  let charge;
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

  if (charge.status !== "paid") {
    // Deliberately leaves the bookings pending: the customer can retry without
    // re-picking their slot, and if they walk away the hold expires on its own.
    await db
      .update(payments)
      .set({ status: "failed", raw: charge.raw, updatedAt: new Date() })
      .where(eq(payments.providerRef, ref));
    return { ok: false, error: "payment-declined" };
  }

  try {
    const tickets = await db.transaction(async (tx) => {
      await tx
        .update(payments)
        .set({
          status: "paid",
          providerRef: charge.providerRef,
          raw: charge.raw,
          updatedAt: new Date(),
        })
        .where(eq(payments.providerRef, ref));

      const numbers = await allocateTickets(
        tx,
        anchor.branchId,
        utcToLocalDate(anchor.startsAt),
        members.length,
      );

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

    const chairs = await db
      .select({ id: stations.id, label: stations.label })
      .from(stations)
      .where(
        inArray(
          stations.id,
          members.map((m) => m.stationId).filter(Boolean) as string[],
        ),
      );
    const labelOf = new Map(chairs.map((c) => [c.id, c.label]));

    // Two separate messages, on purpose. sendConfirmations is the customer's
    // "you're booked" note and goes through the notify() seam, which is still
    // log-only. sendBookingInvoice is the tax invoice and delivers for real via
    // Resend. See docs/INVOICE-EMAIL.md §7 — these should almost certainly be
    // one message once notify() has a real driver.
    //
    // Both are awaited rather than fired and forgotten: on a serverless host the
    // function is frozen the moment this response is returned, so a detached
    // promise would simply never finish. Neither can fail the payment — each
    // swallows its own errors and logs.
    await sendConfirmations(members, tickets, labelOf);
    await sendBookingInvoice(members.map((m) => m.id));

    return {
      ok: true,
      totalHalalas: billTotal,
      tickets: members.map((m, i) => ({
        code: m.code,
        ticketNo: tickets[i],
        stationLabel: m.stationId ? (labelOf.get(m.stationId) ?? null) : null,
        serviceName: m.serviceName,
        startsAt: m.startsAt.toISOString(),
        totalHalalas: m.totalHalalas,
      })),
    };
  } catch (err) {
    // The charge went through but we couldn't confirm. Money was taken for a
    // booking that no longer exists, so this must be loud — a refund is owed.
    console.error(`[payments] charged ${ref} but could not confirm; refund owed`, err);
    return { ok: false, error: "expired" };
  }
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
          serviceName: m.serviceName,
          totalHalalas: m.totalHalalas,
        })),
      },
    });
  } catch (err) {
    console.error("[payments] confirmation message failed", err);
  }
}
