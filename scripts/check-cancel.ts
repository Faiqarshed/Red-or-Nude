// Cancellation window boundary checks (brief §2.6).
//
//   npm run check:cancel
//
// Pure — no database, no network. lib/cancellation.ts is the rule the buttons in
// /my-bookings and the API routes both consult, so these are the boundaries
// themselves rather than a mock of them. Saudi Arabia has no DST and lib/time.ts
// uses a fixed +3 offset, so there is no clock-change case to cover.

import assert from "node:assert";
import { canCancel, cancelDeadline } from "@/lib/cancellation";

const HOUR = 3_600_000;
const CUTOFF = 3;

// A fixed "now" so the checks say the same thing at 3am as at noon.
const now = new Date("2026-08-19T12:00:00.000Z");
const at = (hoursFromNow: number) => new Date(now.getTime() + hoursFromNow * HOUR);

// -- the deadline ------------------------------------------------------------

assert.strictEqual(
  cancelDeadline({ startsAt: at(10), status: "confirmed" }, CUTOFF).toISOString(),
  at(7).toISOString(),
  "deadline is cutoffHours before the appointment",
);

// -- the window --------------------------------------------------------------

assert.ok(
  canCancel({ startsAt: at(4), status: "confirmed" }, CUTOFF, now),
  "4h out is comfortably inside the window",
);

assert.ok(
  !canCancel({ startsAt: at(2.9833), status: "confirmed" }, CUTOFF, now),
  "2h59m out is past the cutoff",
);

// The boundary itself. Exactly on the deadline is too late, so a booking is
// never both cancellable and not in the same millisecond.
assert.ok(
  !canCancel({ startsAt: at(3), status: "confirmed" }, CUTOFF, now),
  "exactly 3h out is refused",
);
assert.ok(
  canCancel({ startsAt: new Date(at(3).getTime() + 1), status: "confirmed" }, CUTOFF, now),
  "one millisecond inside the window is allowed",
);

// An appointment that has already started, or already happened.
assert.ok(!canCancel({ startsAt: at(-1), status: "confirmed" }, CUTOFF, now), "past is refused");

// -- statuses ----------------------------------------------------------------

// An unpaid hold is the customer's to abandon explicitly, not only by walking
// away and waiting out booking_hold_min.
assert.ok(
  canCancel({ startsAt: at(10), status: "pending" }, CUTOFF, now),
  "an unpaid hold can still be cancelled",
);

// Everything else is closed to the customer however far away it is — being in
// the chair is the salon's call, and the rest have nothing left to cancel.
for (const status of ["in_progress", "completed", "cancelled", "no_show"]) {
  assert.ok(
    !canCancel({ startsAt: at(10), status }, CUTOFF, now),
    `${status} is not the customer's to cancel`,
  );
}

// -- a configured cutoff -----------------------------------------------------

// The 3 hours is a setting, not a constant: a salon that wants 24 gets 24.
assert.ok(!canCancel({ startsAt: at(10), status: "confirmed" }, 24, now), "a 24h cutoff bites");
assert.ok(
  canCancel({ startsAt: at(10), status: "confirmed" }, 0, now),
  "a 0h cutoff allows anything not yet started",
);

console.log("check:cancel — all assertions passed");
