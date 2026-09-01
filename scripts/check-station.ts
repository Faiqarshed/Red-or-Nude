// What a QR scan offers (brief §2.7).
//
//   npm run check:station
//
// No database and no network. stationFreeWindow() decides how long each chair is
// free; offerableStations() decides which of those answers the customer is
// actually shown, and that is the part the scan screen's whole shape depends on.

// Must come first: this points DATABASE_URL at the local test database and
// refuses to run if there isn't one. See scripts/_test-db.ts.
import "./_test-db";

import assert from "node:assert";
import { offerableStations } from "@/lib/availability";

const room = [
  { id: "t2", label: "Table 2", token: "tok-2" }, // the scanned chair
  { id: "t1", label: "Table 1", token: "tok-1" },
  { id: "t3", label: "Table 3", token: "tok-3" },
];

const SHORTEST = 45; // the shortest service on the menu

// -- the scanned chair is free after them ------------------------------------

const stay = offerableStations(room, [57, 0, 90], "t2", SHORTEST);
assert.equal(stay[0].isCurrent, true, "the scanned chair leads when it qualifies");
assert.equal(stay[0].freeMin, 57);
// The page keys its entire layout off options[0].isCurrent, so a chair that is
// free for longer must not be allowed to outrank the one they are sitting in.
assert.deepEqual(
  stay.map((s) => s.token),
  ["tok-2", "tok-3"],
  "Table 1 has no window, Table 3 follows the scanned chair",
);

// Order of the input must not change the answer — the caller is a SQL query
// sorted by `sort`, and that is not the order the screen needs.
const shuffled = offerableStations(
  [room[1], room[2], room[0]],
  [0, 90, 57],
  "t2",
  SHORTEST,
);
assert.equal(shuffled[0].isCurrent, true, "the scanned chair leads whatever the row order");

// -- the scanned chair is taken --------------------------------------------

const moved = offerableStations(room, [0, 60, 90], "t2", SHORTEST);
assert.equal(moved.length, 2, "two alternatives are on offer");
assert.ok(
  moved.every((s) => !s.isCurrent),
  "and none of them is the chair they are sitting in",
);

// -- a window too short to sell anything ------------------------------------
//
// The bug this rules out: a chair free for four minutes counted as "free", so
// the page announces a table it cannot sell a single service at.

const tooShort = offerableStations(room, [30, 44, 44], "t2", SHORTEST);
assert.deepEqual(tooShort, [], "a window shorter than the shortest service is not free");

// Exactly the shortest service still fits — the boundary is inclusive, or the
// last bookable slot of every day quietly disappears.
assert.equal(
  offerableStations(room, [45, 0, 0], "t2", SHORTEST).length,
  1,
  "a window equal to the shortest service is offered",
);

// -- nothing free at all -----------------------------------------------------

assert.deepEqual(
  offerableStations(room, [0, 0, 0], "t2", SHORTEST),
  [],
  "a fully booked room offers nothing, and the page says so rather than selling",
);

// A missing window is treated as busy, never as unbounded free time.
assert.deepEqual(offerableStations(room, [], "t2", SHORTEST), []);

console.log("check:station — ok");
