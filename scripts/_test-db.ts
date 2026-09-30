// The gate every script under scripts/ goes through before it can reach a
// database. Import it *first*, above every other import.
//
// Why it exists: the check scripts are not read-only. They set their fixtures up
// by emptying tables outright — check-booking.ts does
//
//     await db.delete(bookings).where(eq(bookings.branchId, branchId));
//
// against whichever branch `select … from branches limit 1` happens to return.
// Pointed at a real database that deletes the salon's bookings, and on
// 2026-09-01 it did: eighty bookings going back to 17 August, gone, past the
// six-hour restore window before anyone noticed. The payments rows survived
// because they do not cascade, which is the only reason the money is still on
// record.
//
// So the scripts no longer read DATABASE_URL at all. They read
// TEST_DATABASE_URL, and this refuses to start if that is missing, if it is not
// on this machine, or if the database is not named for what it is. Three
// separate mistakes have to line up before a script can touch anything real.

import { config } from "dotenv";

config({ path: ".env.local" });

const url = process.env.TEST_DATABASE_URL;

function refuse(why: string): never {
  console.error(
    [
      "",
      `  Refusing to run: ${why}`,
      "",
      "  Scripts under scripts/ delete whole tables to build their fixtures, so",
      "  they only ever run against a local, throwaway database.",
      "",
      "  It must be a *different* database from DATABASE_URL. Two entries in",
      "  .env.local, two databases — the app keeps one, the scripts empty the",
      "  other:",
      "",
      "    DATABASE_URL=postgresql://postgres:<password>@localhost:5432/red_or_nude",
      "    TEST_DATABASE_URL=postgresql://postgres:<password>@localhost:5432/red_or_nude_test",
      "",
      "  Then create and migrate it:",
      "",
      "    createdb red_or_nude_test",
      "    npm run db:migrate:test",
      "    npm run db:seed",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

if (!url) refuse("TEST_DATABASE_URL is not set");

let parsed: URL;
try {
  parsed = new URL(url);
} catch {
  refuse("TEST_DATABASE_URL is not a valid connection string");
}

// On this machine, and nowhere else. A tunnel to something remote would still
// pass this, which is why the name check below is not the only one.
if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
  refuse(`TEST_DATABASE_URL points at ${parsed.hostname}, which is not this machine`);
}

// Named for what it is. Deleting from a database called `_test` is what the
// person who set it up agreed to; deleting from one called anything else is not.
const name = parsed.pathname.replace(/^\//, "");
if (!name.endsWith("_test")) {
  refuse(`database "${name}" is not named *_test`);
}

// And not the one the app is running on.
//
// The two checks above both pass for a `*_test` database on localhost that
// `DATABASE_URL` also points at — which is the setup a developer ends up with by
// pointing both variables at the one database they created. Everything then
// looks right: the name says test, the host says this machine, the gate says
// yes, and `npm run check` deletes every booking the dev site has made.
//
// That is not a hypothetical. It happened here on 2026-09-11: a customer's
// booking, made minutes earlier through the running site, was destroyed by a
// check run that this gate had already approved. Same signature as 2026-09-01 —
// bookings gone, `payments` rows left standing because they do not cascade.
//
// A throwaway database is one nothing else is using. If the app is pointed at
// it, it is not a throwaway.
if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
  refuse(
    `TEST_DATABASE_URL is the same database the app runs on (${name}) — ` +
      "these scripts would delete the data you are looking at in the browser",
  );
}

// Everything downstream — lib/db, drizzle, the app's own modules — reads
// DATABASE_URL. Rewriting it here means no script has to remember to, and a
// script that forgets to import this file has no database at all rather than
// the wrong one.
process.env.DATABASE_URL = url;

// Same idea for money: .env.local may name a real gateway (PAYMENT_DRIVER=
// streampay), and a test run must never create products, links or charges on
// it. Every suite and check script runs on the fake driver, whatever the file says.
process.env.PAYMENT_DRIVER = "fake";

export const TEST_DATABASE_URL = url;
