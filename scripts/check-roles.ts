// Role screens and the salon floor (brief §3).
//
//   npm run check:roles
//
// No database and no network. Everything asserted here is a pure function that
// the panel itself calls — the capability matrix, the technician picker, the
// monthly code window — so these are the rules, not a mock of them.
//
// What is *not* here, because it cannot be without a live Postgres: the
// ownership guard on the technician's two actions. That one is a WHERE clause,
// and docs/ROLE-SCREENS.md §"Try to break it" walks through proving it by hand.

// Must come first: this points DATABASE_URL at the local test database and
// refuses to run if there isn't one. See scripts/_test-db.ts.
import "./_test-db";

import assert from "node:assert";
import { can, mustHaveBranch, scopedBranchId, ROLE_LABELS } from "@/lib/auth/rbac";
import { chooseTechnician, isToday, planAssignments, type PlannableBooking } from "@/lib/assign";
import { monthWindow, STAFF_CODE_PERCENT } from "@/lib/staff-codes";
import { NAV } from "@/components/admin/nav";
import { busyDuring, overlaps, type SlotRow } from "@/lib/slots";
import type { StaffRole } from "@/lib/db/schema";

const ROLES: StaffRole[] = ["ceo", "admin", "receptionist", "technician"];

// -- the matrix --------------------------------------------------------------

assert.ok(can("ceo", "settings.manage"), "the CEO can reach settings");
assert.ok(can("ceo", "audit.view"), "the CEO can read the audit log");
assert.ok(can("ceo", "bookings.reschedule"), "the CEO can move an appointment");

// Deleting a booking, as opposed to cancelling one. Held by the two roles that
// answer for the records and by nobody who works a counter — a busy desk must
// not be one mis-tap from erasing an appointment.
assert.ok(can("ceo", "bookings.delete"), "the CEO can delete a booking");
assert.ok(can("admin", "bookings.delete"), "an admin can delete a booking");
assert.ok(
  !can("receptionist", "bookings.delete"),
  "the front desk cancels bookings, it does not delete them",
);
assert.ok(!can("technician", "bookings.delete"), "a technician cannot delete a booking");

// Brief §3.3, both halves: admin runs the service list, and admin does not
// touch a booking's timing.
assert.ok(can("admin", "catalog.manage"), "admin manages the service list");
assert.ok(
  !can("admin", "bookings.reschedule"),
  "admin cannot change a booking's timing — brief §3.3",
);
assert.ok(can("admin", "bookings.manage"), "…while still managing bookings otherwise");
assert.ok(!can("admin", "settings.manage"), "admin is not god mode: no settings");
assert.ok(!can("admin", "audit.view"), "admin is not god mode: no audit log");

assert.ok(can("receptionist", "bookings.checkin"), "the front desk checks people in");
assert.ok(!can("receptionist", "catalog.manage"), "the front desk does not edit prices");
assert.ok(!can("receptionist", "staff.performance"), "the front desk does not see KPIs");

assert.deepStrictEqual(
  ROLES.filter((r) => can(r, "bookings.own")),
  ["ceo", "admin", "receptionist", "technician"],
  "everyone can act on their own bookings",
);
assert.ok(
  !can("technician", "bookings.view") && !can("technician", "dashboard.view"),
  "a technician sees their own day and nothing else",
);

// Nobody, ever, without a role.
for (const cap of ["bookings.own", "settings.manage", "bookings.checkin"] as const) {
  assert.ok(!can(null, cap), `a signed-out visitor cannot ${cap}`);
  assert.ok(!can(undefined, cap), `an unknown role cannot ${cap}`);
}

// -- branch scoping ----------------------------------------------------------

assert.strictEqual(scopedBranchId("ceo", "branch-1"), null, "the CEO is not pinned to a branch");
assert.strictEqual(
  scopedBranchId("admin", "branch-1"),
  "branch-1",
  "an admin sees their own branch",
);
assert.strictEqual(
  scopedBranchId("technician", null),
  null,
  "a technician with no branch is not silently given every branch's data by a *filter* — my-day filters by technician_id, not by branch",
);

// -- the sidebar is never empty ---------------------------------------------
//
// The bug this whole change started from: a technician signed in, every nav item
// was gated on a capability they lacked, and they got a blank panel and a
// redirect loop. This asserts the first half can't come back.

for (const role of ROLES) {
  const reachable = NAV.flatMap((g) => g.items).filter((i) => !i.cap || can(role, i.cap));
  assert.ok(reachable.length > 0, `${role} has at least one nav item`);
  assert.ok(
    reachable.some((i) => i.href === "/admin"),
    `${role} can reach /admin, which is where every denial redirects`,
  );
}

for (const role of ROLES) {
  assert.ok(ROLE_LABELS[role].ar && ROLE_LABELS[role].en, `${role} is labelled in both languages`);
}

// The two floor screens follow check-in — not staff.manage, which the
// receptionist who actually sends someone home does not have, and not a
// receptionist-only gate, which would shut out an admin covering the desk.
for (const href of ["/admin/floor", "/admin/front-desk"]) {
  const item = NAV.flatMap((g) => g.items).find((i) => i.href === href);
  assert.ok(item, `${href} is in the sidebar`);
  assert.strictEqual(item!.cap, "bookings.checkin", `${href} is gated on check-in`);

  // Everyone who works a floor can reach it — the desk, and whoever covers it.
  for (const role of ["receptionist", "admin", "ceo"] as StaffRole[]) {
    assert.ok(can(role, item!.cap!), `${role} can reach ${href}`);
  }
  assert.ok(!can("technician", item!.cap!), `a technician cannot reach ${href}`);
}

// -- who takes the next customer --------------------------------------------

const noLoad = new Map<string, number>();

assert.strictEqual(
  chooseTechnician(["a", "b"], new Set(), noLoad),
  "a",
  "an idle floor keeps the given order, so the pick is stable",
);
assert.strictEqual(
  chooseTechnician(["a", "b"], new Set(["a"]), noLoad),
  "b",
  "a technician mid-service is skipped",
);
assert.strictEqual(
  chooseTechnician(["a", "b"], new Set(["a", "b"]), noLoad),
  null,
  "a full floor returns null rather than doubling someone up",
);
assert.strictEqual(chooseTechnician([], new Set(), noLoad), null, "no technicians, no pick");

assert.strictEqual(
  chooseTechnician(["a", "b", "c"], new Set(), new Map([["a", 4], ["b", 1], ["c", 3]])),
  "b",
  "the least loaded takes the next customer",
);
assert.strictEqual(
  chooseTechnician(["a", "b"], new Set(["b"]), new Map([["a", 9], ["b", 0]])),
  "a",
  "busy beats idle-but-unavailable: an unloaded technician who is mid-service is still not free",
);
assert.strictEqual(
  chooseTechnician(["a", "b", "c"], new Set(), new Map([["b", 2], ["c", 2]])),
  "a",
  "a technician with no bookings today counts as zero, not as missing",
);

// -- who is free at a given hour ---------------------------------------------
//
// lib/slots.ts, shared by the assignment engine, the front desk and the floor
// screen. Getting this wrong in one of the three is how a technician ends up
// greyed out on one screen and handed a second customer by another.

const t9 = new Date(Date.UTC(2026, 8, 1, 9));
const t10 = new Date(Date.UTC(2026, 8, 1, 10));
const t11 = new Date(Date.UTC(2026, 8, 1, 11));
const t12 = new Date(Date.UTC(2026, 8, 1, 12));

assert.ok(overlaps(t9, t11, t10, t12), "spans that cross do overlap");
assert.ok(overlaps(t10, t12, t9, t11), "…in either order");
assert.ok(overlaps(t9, t12, t10, t11), "a span wholly inside another overlaps");
assert.ok(
  !overlaps(t10, t11, t11, t12),
  "back-to-back is not a clash — half-open, or half the floor would idle",
);
assert.ok(!overlaps(t9, t10, t11, t12), "spans with a gap do not overlap");

const slot = (over: Partial<SlotRow> = {}): SlotRow => ({
  id: "target",
  technicianId: null,
  startsAt: t10.toISOString(),
  endsAt: t11.toISOString(),
  status: "confirmed",
  ...over,
});

const target = slot();

assert.deepStrictEqual(
  [...busyDuring([slot({ id: "other", technicianId: "a" })], target)],
  ["a"],
  "a technician booked across these hours is busy for them",
);
assert.deepStrictEqual(
  [...busyDuring([slot({ id: "other", technicianId: "a", startsAt: t11.toISOString(), endsAt: t12.toISOString() })], target)],
  [],
  "the technician on the next slot along is free for this one",
);
assert.deepStrictEqual(
  [...busyDuring([slot({ id: "other", technicianId: "a", status: "cancelled" })], target)],
  [],
  "a cancelled booking holds nobody",
);
assert.deepStrictEqual(
  [...busyDuring([slot({ id: "other", technicianId: "a", status: "completed" })], target)],
  [],
  "nor does a closed one",
);
assert.deepStrictEqual(
  [...busyDuring([slot({ technicianId: "a" })], slot({ technicianId: "a" }))],
  [],
  "a booking never makes its own technician unavailable for itself",
);
assert.deepStrictEqual(
  [...busyDuring([slot({ id: "other", technicianId: null })], target)],
  [],
  "an unassigned booking blocks nobody",
);

// -- dealing out the whole day ----------------------------------------------
//
// The morning run (lib/assign/index.ts). Same shape as the block above: the real
// function, no database, so what is asserted here is the rule itself.

/** `n` back-to-back hour-long slots from 10:00, so nothing overlaps. */
function sequentialDay(n: number): PlannableBooking[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `b${i}`,
    startsAt: new Date(Date.UTC(2026, 8, 1, 7 + i)),
    endsAt: new Date(Date.UTC(2026, 8, 1, 8 + i)),
  }));
}

function spread(plan: Map<string, string | null>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tech of plan.values()) {
    if (tech) counts.set(tech, (counts.get(tech) ?? 0) + 1);
  }
  return counts;
}

// The whole point of the feature: six bookings across three technicians is
// 2/2/2, not 6/0/0 for whoever sorts first.
const even = planAssignments(sequentialDay(6), ["a", "b", "c"]);
assert.deepStrictEqual(
  [...spread(even).values()].sort(),
  [2, 2, 2],
  "a day of six spreads evenly across three technicians",
);
assert.ok([...even.values()].every(Boolean), "…and every booking got someone");

// Overlap is the thing a count-based rule cannot see on its own.
const sameTime: PlannableBooking[] = [
  { id: "x", startsAt: new Date(Date.UTC(2026, 8, 1, 7)), endsAt: new Date(Date.UTC(2026, 8, 1, 9)) },
  { id: "y", startsAt: new Date(Date.UTC(2026, 8, 1, 8)), endsAt: new Date(Date.UTC(2026, 8, 1, 10)) },
];
const overlapping = planAssignments(sameTime, ["a", "b"]);
assert.notStrictEqual(
  overlapping.get("x"),
  overlapping.get("y"),
  "two overlapping slots never land on the same technician",
);

// Back-to-back is not an overlap: 10–11 and 11–12 are exactly how a chair is
// meant to be used, so the same technician may take both.
const backToBack = planAssignments(sequentialDay(2), ["a"]);
assert.deepStrictEqual(
  [backToBack.get("b0"), backToBack.get("b1")],
  ["a", "a"],
  "consecutive appointments stack on one technician — half-open intervals",
);

// More overlapping work than technicians: the surplus comes back null for the
// receptionist to sort out, rather than double-booking someone.
const crowded = planAssignments(
  [
    ...sameTime,
    { id: "z", startsAt: new Date(Date.UTC(2026, 8, 1, 8, 30)), endsAt: new Date(Date.UTC(2026, 8, 1, 9, 30)) },
  ],
  ["a", "b"],
);
assert.strictEqual([...crowded.values()].filter((v) => v === null).length, 1, "the surplus is left unassigned, not doubled up");

// Someone off today simply is not a candidate — assignDay filters them out
// before calling this, which is what excluding them from the list models.
const withoutNoura = planAssignments(sequentialDay(4), ["a", "c"]);
assert.ok(
  ![...withoutNoura.values()].includes("noura"),
  "a technician on leave takes no bookings, however light her load",
);

// A booking a receptionist already assigned by hand tilts the rest away from
// that person, instead of the run pretending the day starts empty.
const tilted = planAssignments(sequentialDay(2), ["a", "b"], new Map([["a", 5]]));
assert.deepStrictEqual(
  [tilted.get("b0"), tilted.get("b1")],
  ["b", "b"],
  "an existing manual load is counted: five ahead, and the run keeps catching up",
);

// …and once the gap is one, the day alternates as you would expect.
const level = planAssignments(sequentialDay(2), ["a", "b"], new Map([["a", 1]]));
assert.deepStrictEqual(
  [level.get("b0"), level.get("b1")],
  ["b", "a"],
  "one booking behind, and the next two go one each",
);

// Existing commitments block their own hours, so the run cannot hand a manually
// assigned technician a second customer at the same time.
const held = new Map([
  ["a", [{ startsAt: new Date(Date.UTC(2026, 8, 1, 7)), endsAt: new Date(Date.UTC(2026, 8, 1, 8)) }]],
]);
assert.strictEqual(
  planAssignments(sequentialDay(1), ["a", "b"], new Map(), held).get("b0"),
  "b",
  "a technician already booked for that hour is skipped for it",
);

// The floor can be empty — a public holiday, everyone on leave — and nothing
// here may throw. The salon still opens; the desk assigns by hand.
assert.deepStrictEqual(
  [...planAssignments(sequentialDay(3), []).values()],
  [null, null, null],
  "no available technicians leaves every booking unassigned, without throwing",
);
assert.strictEqual(planAssignments([], ["a"]).size, 0, "an empty day plans nothing");

// The caller's maps are inputs, not scratch space — assignDay reuses them.
const callersLoad = new Map([["a", 1]]);
planAssignments(sequentialDay(2), ["a", "b"], callersLoad);
assert.deepStrictEqual([...callersLoad], [["a", 1]], "the caller's load map is left alone");

// -- when the floor is re-dealt live -----------------------------------------
//
// assignIfToday is the whole of the automation added on top of the dawn cron,
// and this predicate is the whole of its rule. Everything else it does —
// assignDay — is asserted above; what is left to get wrong is *which day*, and
// the trap is that Riyadh is UTC+3, so a comparison written against UTC dates
// passes locally and mis-assigns three hours a night in production.

// The one that would break a naive toISOString().slice(0, 10): 23:00 UTC and
// 05:00 UTC the next UTC day are both the 30th in Riyadh, and an appointment at
// 08:00 that morning must be assigned by a payment taken at 02:00.
assert.ok(
  isToday(new Date("2026-08-30T05:00:00Z"), new Date("2026-08-29T23:00:00Z")),
  "two UTC days, one Riyadh day — a booking after midnight local is still today",
);

// And the mirror: 21:00 UTC is already tomorrow in Riyadh, so an appointment at
// 21:00 UTC the same UTC day belongs to the run that has not happened yet.
assert.ok(
  !isToday(new Date("2026-08-30T21:00:00Z"), new Date("2026-08-30T12:00:00Z")),
  "one UTC day, two Riyadh days — an appointment past local midnight is not today",
);

assert.ok(
  isToday(new Date("2026-08-30T06:00:00Z"), new Date("2026-08-30T18:00:00Z")),
  "morning and evening of the same Riyadh day are the same day",
);
assert.ok(
  !isToday(new Date("2026-09-05T09:00:00Z"), new Date("2026-08-30T09:00:00Z")),
  "next week is the dawn run's job, not this one's",
);
assert.ok(
  !isToday(new Date("2026-08-29T09:00:00Z"), new Date("2026-08-30T09:00:00Z")),
  "yesterday is nobody's job",
);

// -- who may span branches ---------------------------------------------------
//
// scopedBranchId reads a null branch as "no filter". That is deliberate for the
// CEO and a regional admin, and would be a data leak for anyone else — so the
// staff form refuses to save a receptionist or technician without a branch.
// This asserts the reason that rule exists, not the form itself.

assert.deepStrictEqual(
  ROLES.filter(mustHaveBranch),
  ["receptionist", "technician"],
  "the desk and the floor belong to one branch; the CEO and a regional admin do not",
);
assert.strictEqual(
  scopedBranchId("receptionist", null),
  null,
  "an unpinned receptionist is filtered by nothing — which is why saveStaff refuses one",
);
assert.strictEqual(
  scopedBranchId("receptionist", "branch-1"),
  "branch-1",
  "…and a pinned one sees her own branch only",
);
assert.strictEqual(scopedBranchId("ceo", "branch-1"), null, "the CEO spans branches by design");

// -- the monthly staff code window -------------------------------------------

const mid = new Date("2026-08-17T09:30:00.000Z");
const { start, end } = monthWindow(mid);

assert.strictEqual(start.toISOString(), "2026-08-01T00:00:00.000Z", "the window opens on the 1st");
assert.strictEqual(
  end.toISOString(),
  "2026-09-01T00:00:00.000Z",
  "and closes as the next month opens — so an unused code lapses by itself",
);
assert.ok(start < mid && mid < end, "the date it was issued on falls inside its own window");

// December has to roll the year, not the month to 13.
const december = monthWindow(new Date("2026-12-09T00:00:00.000Z"));
assert.strictEqual(
  december.end.toISOString(),
  "2027-01-01T00:00:00.000Z",
  "December's window closes in January of the next year",
);

// The same month from either end lands on the same window — that identity is
// what makes issueMonthlyCode idempotent for a cron that fires late.
assert.deepStrictEqual(
  monthWindow(new Date("2026-08-01T00:00:00.000Z")),
  monthWindow(new Date("2026-08-31T23:59:59.000Z")),
  "the 1st and the 31st ask for the same month",
);

assert.ok(
  STAFF_CODE_PERCENT > 0 && STAFF_CODE_PERCENT <= 100,
  "the staff discount is a percentage a promo code can actually express",
);

console.log("check:roles — all role, assignment and staff-code checks passed");
