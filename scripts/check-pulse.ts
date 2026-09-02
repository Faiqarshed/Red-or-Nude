// The booking colour rule, every state.
//
//   npm run check:pulse
//
// Pure — no database, no browser. What it protects is the one line in
// lib/booking-pulse.ts a future edit is most likely to "tidy": that finished is
// `finished_at` and not `completed`. Get that wrong and nothing crashes; a
// finished chair just quietly pulses green until reception closes the ticket,
// and nobody files a bug about a colour.

import assert from "node:assert/strict";
import { statusPulse, type PulseInput } from "@/lib/booking-pulse";
import { serviceClock } from "@/lib/booking-clock";

const FINISHED = "2025-09-02T10:00:00.000Z";

const YELLOW = /animate-row-checkin/;
const GREEN = /animate-running-pulse/;
const STATIC = /bg-\[#1f7a4d\]\/10/;

function check(label: string, input: PulseInput, expect: RegExp | null) {
  const got = statusPulse(input);
  if (expect) assert.match(got, expect, `${label}: got "${got}"`);
  else assert.equal(got, "", `${label}: expected no classes, got "${got}"`);
  console.log(`  ok  ${label}`);
}

console.log("\nbooking status lights\n");

// The four states the salon reads off the screen.
check("nobody has arrived yet", { status: "confirmed" }, null);
check("customer is waiting for a technician", { status: "checked_in" }, YELLOW);
check("technician is working", { status: "in_progress", finishedAt: null }, GREEN);
check("technician finished, ticket still open", { status: "in_progress", finishedAt: FINISHED }, STATIC);
check("receptionist has closed the ticket", { status: "completed", finishedAt: FINISHED }, STATIC);

// The states that keep whatever styling they had.
check("unpaid hold", { status: "pending" }, null);
check("cancelled", { status: "cancelled" }, null);
check("never turned up", { status: "no_show" }, null);

// `finishedAt` may be absent entirely: /admin/bookings selects it, the front
// desk's row shape does not, and both hand rows to the same function.
check("running row with the field omitted", { status: "in_progress" }, GREEN);

// Closed by hand from the status dropdown with no technician ever pressing
// Finish. `completed` alone has to be enough.
check("completed with no finish stamp", { status: "completed", finishedAt: null }, STATIC);

// Waiting outranks finishing, so a status walked backwards by an admin does not
// leave a stale `finished_at` showing green.
check("checked in again after a finish stamp", { status: "checked_in", finishedAt: FINISHED }, YELLOW);

// Every moving state needs a static twin, or reduced-motion users get a row
// that says nothing at all.
for (const status of ["checked_in", "in_progress"] as const) {
  const got = statusPulse({ status });
  assert.match(got, /motion-reduce:animate-none/, `${status}: no reduced-motion fallback`);
  assert.match(got, /motion-reduce:bg-/, `${status}: reduced motion drops the colour too`);
  console.log(`  ok  ${status} still readable with motion off`);
}

// The desk's clock counts the visit, wait included — not the technician's
// working time, which /admin/performance still reads as started → finished.
console.log("\ndesk clock\n");

const CHECKED_IN = "2025-09-02T10:00:00.000Z";
const STARTED = "2025-09-02T10:30:00.000Z";
const DONE = "2025-09-02T11:00:00.000Z";
const NOW = new Date("2025-09-02T10:45:00.000Z").getTime();
const MIN = 60_000;
const FINISHED_ROW = { checkedInAt: CHECKED_IN, startedAt: STARTED, finishedAt: DONE };

function checkClock(
  label: string,
  input: Parameters<typeof serviceClock>[0],
  at: number,
  expect: { runningMs: number | null; tookMs: number | null },
) {
  assert.deepEqual(serviceClock(input, at), expect, label);
  console.log(`  ok  ${label}`);
}

// Running before anyone picks her up, and still counting the wait once they do:
// 15 minutes in the chair, but she has been in the building for 45.
checkClock("waiting 45 min, still counting", { checkedInAt: CHECKED_IN }, NOW, { runningMs: 45 * MIN, tookMs: null });
checkClock("in service counts the wait too", { checkedInAt: CHECKED_IN, startedAt: STARTED }, NOW, { runningMs: 45 * MIN, tookMs: null }); // prettier-ignore

// Settles at Finish and stays there, however long the ticket then sits waiting
// for the desk to close it.
checkClock("finished settles at 60 min", FINISHED_ROW, NOW, { runningMs: null, tookMs: 60 * MIN });
checkClock("and has not moved six hours later", FINISHED_ROW, NOW + 6 * 60 * MIN, { runningMs: null, tookMs: 60 * MIN }); // prettier-ignore

// A walk-in pushed straight to in_progress has no check-in stamp.
checkClock("no check-in stamp falls back to start", { startedAt: STARTED }, NOW, { runningMs: 15 * MIN, tookMs: null });
checkClock("nothing stamped yet reads as no clock", {}, NOW, { runningMs: null, tookMs: null });

// Clock skew must not print a negative duration.
checkClock("a check-in in the future clamps to zero", { checkedInAt: DONE }, NOW, { runningMs: 0, tookMs: null });

console.log("\nall checks passed\n");
