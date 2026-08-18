// Emailing the invoice for a paid booking.
//
// Deliberately total: this is called from the payment path, after the card has
// been charged and the tickets issued. At that point the booking is real whether
// or not the mail goes out, so every failure below is swallowed and logged.
// Nothing here is allowed to throw into confirmBookingPayment.

import "server-only";
import { sendMail } from "@/lib/email/resend";
import { buildBookingInvoice } from "./data";
import { renderInvoiceEmail } from "./template";

export type SendInvoiceOutcome =
  | { sent: true; number: string }
  | { sent: false; reason: "no-email" | "not-configured" | "failed" };

/**
 * `bookingIds` is every guest on the bill, in ticket order — one id for a single
 * booking, two for a group. A group gets one invoice listing both guests, since
 * one card was charged once.
 */
export async function sendBookingInvoice(bookingIds: string[]): Promise<SendInvoiceOutcome> {
  try {
    const invoice = await buildBookingInvoice(bookingIds);
    // No email on file — walk-ins and phone bookings legitimately have none.
    if (!invoice) return { sent: false, reason: "no-email" };

    const { subject, html, text } = renderInvoiceEmail(invoice);

    const result = await sendMail({
      to: invoice.customer.email,
      toName: invoice.customer.name,
      subject,
      html,
      text,
      replyTo: process.env.MAIL_REPLY_TO?.trim() || null,
      tags: ["booking-invoice"],
    });

    if (!result.ok) {
      // Loud on purpose: the customer paid and has no receipt. Someone has to be
      // able to find this in the logs and resend it by hand.
      console.error(
        `[invoice] ${invoice.number} to ${invoice.customer.email} was not delivered:`,
        result.reason,
        result.detail ?? "",
      );
      return { sent: false, reason: result.reason === "not-configured" ? "not-configured" : "failed" };
    }

    console.info(`[invoice] ${invoice.number} sent to ${invoice.customer.email}`);
    return { sent: true, number: invoice.number };
  } catch (err) {
    console.error("[invoice] could not build or send the invoice", err);
    return { sent: false, reason: "failed" };
  }
}
