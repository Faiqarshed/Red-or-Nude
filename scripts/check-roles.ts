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

import assert from "node:assert";
import { can, scopedBranchId, ROLE_LABELS } from "@/lib/auth/rbac";
import { chooseTechnician } from "@/lib/assign";
import { monthWindow, STAFF_CODE_PERCENT } from "@/lib/staff-codes";
import { NAV } from "@/components/admin/nav";
import type { StaffRole } from "@/lib/db/schema";

const ROLES: StaffRole[] = ["ceo", "admin", "receptionist", "technician"];

// -- the matrix --------------------------------------------------------------

assert.ok(can("ceo", "settings.manage"), "the CEO can reach settings");
assert.ok(can("ceo", "audit.view"), "the CEO can read the audit log");
assert.ok(can("ceo", "bookings.reschedule"), "the CEO can move an appointment");

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
