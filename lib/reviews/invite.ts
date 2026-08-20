// Asking a customer to rate the appointment they just finished (brief §2.9).
//
// Deliberately total, exactly like lib/invoice/send.ts: this runs after a
// receptionist has already pressed End, the appointment is closed and the money
// is long since taken. Every failure below is swallowed and logged. Nothing here
// is allowed to throw into setBookingStatus.

import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, reviews } from "@/lib/db/schema";
import { sendMail } from "@/lib/email";
import { renderReviewEmail } from "./email";

export type InviteOutcome =
  | { sent: true }
  | { sent: false; reason: "already-invited" | "no-email" | "not-found" | "not-configured" | "failed" };

/**
 * Create the review row for a finished booking and email its link.
 *
 * The insert comes first and decides everything. `reviews_booking_unique` means
 * a second call inserts nothing, gets no row back and sends no mail — so a
 * receptionist who presses End twice, or an action that gets retried, cannot
 * produce two emails. The database settles it rather than a read that two
 * concurrent calls could both pass.
 */
export async function inviteReview(bookingId: string): Promise<InviteOutcome> {
  try {
    const [review] = await db
      .insert(reviews)
      .values({ bookingId })
      .onConflictDoNothing({ target: reviews.bookingId })
      .returning({ token: reviews.token });

    if (!review) return { sent: false, reason: "already-invited" };

    const [row] = await db
      .select({
        serviceName: bookings.serviceName,
        email: customers.email,
        name: customers.name,
        lang: customers.lang,
      })
      .from(bookings)
      .leftJoin(customers, eq(customers.id, bookings.customerId))
      .where(eq(bookings.id, bookingId))
      .limit(1);

    if (!row) return { sent: false, reason: "not-found" };

    // Walk-ins and phone bookings legitimately have no address. The row stays —
    // it records that this appointment was never asked, which is the difference
    // between a low response rate and a low invite rate.
    const email = row.email?.trim();
    if (!email) return { sent: false, reason: "no-email" };

    const lang = row.lang ?? "ar";
    const { subject, html, text } = renderReviewEmail({
      token: review.token,
      customerName: row.name,
      serviceName: row.serviceName?.[lang] ?? null,
      lang,
    });

    const result = await sendMail({
      to: email,
      toName: row.name,
      subject,
      html,
      text,
      replyTo: process.env.MAIL_REPLY_TO?.trim() || null,
      tags: ["review-invite"],
    });

    if (!result.ok) {
      console.error(
        `[review] invite for booking ${bookingId} was not delivered:`,
        result.reason,
        result.detail ?? "",
      );
      return {
        sent: false,
        reason: result.reason === "not-configured" ? "not-configured" : "failed",
      };
    }

    console.info(`[review] invite sent to ${email} for booking ${bookingId}`);
    return { sent: true };
  } catch (err) {
    console.error("[review] could not send the rating invitation", err);
    return { sent: false, reason: "failed" };
  }
}
