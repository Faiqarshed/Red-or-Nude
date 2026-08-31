// Live technician assignment (docs/LIVE-ASSIGNMENT.md).
//
//   npm run check:assign
//
// The one check in this family that needs a live Postgres, and deliberately so.
// scripts/check-roles.ts covers everything about assignment that is a pure
// function — who is eligible, how the day is planned, which day counts as today
// — and says in its own header that what it cannot cover is a WHERE clause.
//
// This is that WHERE clause. "A cancelled booking stops blocking its
// technician" lives in a SQL filter and nowhere else, so nothing short of real
// rows in a real database can tell you whether it is there. Delete the
// notInArray in lib/assign/index.ts and check 4 below fails; that is the whole
// reason this file exists.
//
// It writes to the database it is pointed at. Every row it makes is removed
// again on the way out, including on failure — never run it at a real salon.

import { config } from "dotenv";
config({ path: ".env.local" });
import assert from "node:assert";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, staff, staffTimeOff, auditLog } from "@/lib/db/schema";
import { assignDay, assignIfToday, releaseToday } from "@/lib/assign";
import { riyadhDayRange, riyadhDateKey } from "@/lib/time";

const made: string[] = [];
const timeOff: string[] = [];

const { start } = riyadhDayRange();
const at = (hour: number, mins = 45) => {
  const s = new Date(start.getTime() + hour * 3600_000);
  return { startsAt: s, endsAt: new Date(s.getTime() + mins * 60_000) };
};

async function put(label: string, when: { startsAt: Date; endsAt: Date }) {
  const [row] = await db
    .insert(bookings)
    .values({
      code: `ZZ-${label}-${Math.random().toString(36).slice(2, 7)}`,
      branchId: BRANCH,
      status: "confirmed",
      ...when,
    })
    .returning({ id: bookings.id });
  made.push(row.id);
  return row.id;
}

const techOf = async (id: string) =>
  (await db.select({ t: bookings.technicianId }).from(bookings).where(eq(bookings.id, id)).limit(1))[0].t;

// Whichever branch has technicians. Filled in by main() before anything reads it.
let BRANCH = "";

/** More overlapping bookings than any real salon staffs one hour with. */
const CROWD = 8;

async function main() {
  const [anyTech] = await db
    .select({ branchId: staff.branchId })
    .from(staff)
    .where(and(eq(staff.role, "technician"), eq(staff.active, true)))
    .limit(1);
  if (!anyTech?.branchId) throw new Error("no active technicians — seed the database first");
  BRANCH = anyTech.branchId;
  console.log(`branch ${BRANCH.slice(0, 8)}\n`);

  // 1. a booking paid for after the dawn run gets a technician there and then
  const solo = await put("solo", at(21));
  await assignIfToday(BRANCH, at(21).startsAt);
  const soloTech = await techOf(solo);
  assert.ok(soloTech, "1. a confirmed booking today is assigned live");
  console.log(`1. paid for after the run     assigned to ${soloTech.slice(0, 8)}   PASS`);

  // 2. next week is left for the dawn run on the day
  const tmrw = {
    startsAt: new Date(at(21).startsAt.getTime() + 864e5),
    endsAt: new Date(at(21).endsAt.getTime() + 864e5),
  };
  const later = await put("tmrw", tmrw);
  await assignIfToday(BRANCH, tmrw.startsAt);
  assert.strictEqual(await techOf(later), null, "2. a future day is not assigned live");
  console.log("2. booked for tomorrow        still unassigned         PASS");

  // 3. more overlapping work than the floor can hold: everyone who is in gets
  //    exactly one, and the surplus waits for the desk rather than doubling up.
  const hour = at(23);
  const crowd: string[] = [];
  for (let i = 0; i < CROWD; i++) crowd.push(await put(`f${i}`, hour));
  await assignDay(BRANCH);
  const holders = await Promise.all(crowd.map(techOf));
  const busy = holders.filter(Boolean) as string[];
  const spare = crowd.filter((_, i) => !holders[i]);

  assert.strictEqual(new Set(busy).size, busy.length, "3. nobody holds two customers at once");
  assert.ok(spare.length >= 1, "3. the surplus is left for the desk, not doubled up");
  console.log(
    `3. ${crowd.length} booked for one hour     ${busy.length} assigned, ${spare.length} left over   PASS`,
  );

  // 4. THE FIX. One of them cancels. Her technician's hour is free again, and
  //    the surplus booking that had nobody now has her — which is exactly what
  //    the run could not see while cancelled rows still blocked a technician.
  const overflow = spare[0];
  const freed = holders[0]!;
  await db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.id, crowd[0]));
  await assignDay(BRANCH);
  assert.strictEqual(
    await techOf(overflow),
    freed,
    "4. a cancelled booking stops blocking its technician",
  );
  console.log(`4. one of them cancels        surplus takes ${freed.slice(0, 8)}   PASS`);

  // 5. sent home: her waiting customer is emptied and re-dealt to someone else,
  //    and the time-off row is what stops the run handing him straight back.
  const quiet = at(20);
  const hers = await put("home", quiet);
  await assignDay(BRANCH);
  const before = (await techOf(hers))!;
  const [row] = await db
    .insert(staffTimeOff)
    .values({ staffId: before, startsOn: riyadhDateKey(), endsOn: riyadhDateKey(), reason: "sent home" })
    .returning({ id: staffTimeOff.id });
  timeOff.push(row.id);
  await db.update(bookings).set({ technicianId: null }).where(eq(bookings.id, hers));
  await assignIfToday(BRANCH, quiet.startsAt);
  const after = await techOf(hers);
  assert.ok(after, "5. the released booking found someone");
  assert.notStrictEqual(after, before, "5. …and never the technician who went home");
  console.log(`5. technician sent home       ${before.slice(0, 8)} → ${after!.slice(0, 8)}   PASS`);

  // 6. one dealer per branch. Two runs reading the floor at the same moment
  //    both see the same technician free and both hand her a customer, so the
  //    read and the write have to be one stretch nobody else can get into.
  //
  //    Asserted by what the run *sees*, not by how long it takes — a stopwatch
  //    against a remote database measures the network, not the lock. This holds
  //    the branch by hand, starts a run, and only then commits a new booking. A
  //    run that waited its turn reads the floor afterwards and finds it; a run
  //    that walked straight past read a second earlier and never will. Comment
  //    out lockBranch in lib/assign/index.ts and this fails.
  const started: Promise<unknown>[] = [];
  const late: string[] = [];

  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${BRANCH}))`);
    started.push(assignDay(BRANCH));

    // Long enough that an unlocked run is certainly past its own read.
    await new Promise((r) => setTimeout(r, 1000));

    const [row] = await tx
      .insert(bookings)
      .values({
        code: `ZZ-lock-${Math.random().toString(36).slice(2, 7)}`,
        branchId: BRANCH,
        status: "confirmed",
        ...at(19),
      })
      .returning({ id: bookings.id });
    made.push(row.id);
    late.push(row.id);
  });

  await started[0];
  assert.ok(await techOf(late[0]), "6. a second run waits, then deals what the first could not see");
  console.log("6. two runs at once           the second waited        PASS");
  // 7. she goes home while a customer is running late. His appointment started
  //    twenty minutes ago and he has not checked in, so his row still says
  //    `confirmed` with her name on it. Releasing only what starts in the
  //    *future* leaves exactly him behind — and nothing comes back for the row,
  //    because assignDay only fills empty ones. He walks in and is sent to
  //    somebody who left the building.
  //
  //    "Not yet started" is the status, never the clock. Put a
  //    `gte(bookings.startsAt, new Date())` back into releaseToday and the
  //    first assertion fails.
  const past = new Date(Math.max(start.getTime(), Date.now() - 30 * 60_000));
  const running = await put("late", {
    startsAt: past,
    endsAt: new Date(past.getTime() + 45 * 60_000),
  });
  await assignDay(BRANCH);
  const onHer = (await techOf(running))!;

  // Someone she has actually started, handed to her by name. Hers either way.
  const seated = await put("seat", at(22));
  await db
    .update(bookings)
    .set({ technicianId: onHer, status: "checked_in" })
    .where(eq(bookings.id, seated));

  const letGo = await releaseToday(onHer);

  assert.strictEqual(await techOf(running), null, "7. a late customer's booking is released too");
  assert.ok(letGo.includes(running), "7. ...and is reported as released");
  assert.strictEqual(await techOf(seated), onHer, "7. the customer already with her stays hers");
  console.log(`7. sent home, one running late  released ${letGo.length}            PASS`);


  console.log("\ncheck:assign — seven live checks passed against Postgres");
}

async function cleanup() {
  if (made.length) {
    await db.delete(auditLog).where(inArray(auditLog.entityId, made));
    await db.delete(bookings).where(inArray(bookings.id, made));
  }
  if (timeOff.length) await db.delete(staffTimeOff).where(inArray(staffTimeOff.id, timeOff));
  console.log(`cleaned up ${made.length} bookings, ${timeOff.length} time-off rows`);
}

main().then(
  async () => {
    await cleanup();
    process.exit(0);
  },
  async (e) => {
    console.error(e.message ?? e);
    await cleanup();
    process.exit(1);
  },
);
