// What it takes to *act* on a booking, as opposed to look at one.
//
// Reading is open: a reference alone opens a booking at POST /api/my-bookings,
// because it arrives in the customer's own inbox and the summary it returns
// carries no name, phone or email. Changing one is not, because cancelling
// moves money and rescheduling takes someone else's slot.
//
// Two credentials, one rule, written once because cancel, reschedule and refill
// all need it and a rule that disagrees with itself across three routes is how
// a booking becomes cancellable from one URL and not another:
//
//   • a signed-in customer, *if the booking is theirs*. The session proves who
//     you are and nothing more — without the ownership equality any signed-in
//     customer could cancel any booking whose reference they knew, which would
//     be weaker than the guest path, not stronger.
//
//   • anyone else, with a code emailed to the booking's own address. Knowing
//     the reference is not enough; a forwarded confirmation should not carry
//     the power to cancel.
//
// A group shares one customerId — createBookings() writes the booker's id to
// every member — so ownership of the anchor is ownership of the group, and
// cancelling as a unit needs no second check.

import "server-only";
import { currentCustomer } from "@/lib/account/guard";
import { bookingSubject, verifyOtp } from "@/lib/otp";

export type BookingAuthFailure = {
  /** Response body error code. */
  error: "otp-required" | "wrong" | "no-code" | "too-many-attempts";
  status: 401 | 429;
};

/**
 * Decide whether this request may change `booking`.
 *
 * Returns null when it may. `otp` is whatever the body carried, which is
 * nothing at all on the first attempt — a guest is *expected* to be turned away
 * once with `otp-required`, which is the screen's cue to ask for a code.
 *
 * Callers must have already established that the booking exists. They need not
 * disguise an unknown reference as a refused one: POST /api/my-bookings answers
 * whether a reference is real, openly and on purpose, so there is nothing left
 * for these routes to hide.
 */
export async function refuseBookingAction(
  booking: { id: string; customerId: string | null },
  otp: string | undefined,
): Promise<BookingAuthFailure | null> {
  const customer = await currentCustomer();
  if (customer && booking.customerId === customer.id) return null;

  if (!otp) return { error: "otp-required", status: 401 };

  const check = await verifyOtp(bookingSubject(booking.id), otp);
  if (check.ok) return null;

  return {
    error: check.reason,
    status: check.reason === "too-many-attempts" ? 429 : 401,
  };
}
