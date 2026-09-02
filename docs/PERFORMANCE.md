# Performance

What was actually slow, what was changed because of it, and what was left alone
on purpose.

The short version: **the database was never the problem.** Every optimisation
here removes a network round trip. None of them makes a query faster, because no
query was slow.

## The measurement

Neon's query insights, over a short working session against the development
database:

| Calls | Avg | Total | Query |
|---|---|---|---|
| 28 | 0.9 ms | 24.6 ms | `pg_catalog.pg_type` — the driver introducing itself on a new connection |
| 2 | 7.2 ms | 14.5 ms | `insert into audit_log` |
| 114 | 0.1 ms | 11.7 ms | the front desk's day query |
| 241 | 0 ms | 7.7 ms | `select id, name from branches` |
| 123 | 0 ms | 4.2 ms | the no-show sweep |
| 245 | 0 ms | 6.9 ms | `select key, value from settings` (two shapes) |
| 8 | 0.1 ms | 1 ms | `select booking_id, name from booking_addons` — no `where` |

Two things fall out of that table.

**Nothing is slow.** The whole list, hundreds of calls added together, is well
under a second of database work. The single most expensive entry is the
driver's connection handshake, not any query we wrote. When the top cost in a
database is saying hello, the database is idle.

**The cost is per call, not per query.** The database is in `eu-central-1`
(Frankfurt). A round trip from the salon in Riyadh is a few milliseconds; from a
developer's laptop in Pakistan it is 120–150 ms. Either way the figure that
matters is how many times we go and ask, not how long the answer takes to
compute. 241 branch lookups returning two rows that change once a year is 241
round trips spent on nothing.

So every change below deletes calls. Indexes and query tuning, the usual first
instinct, would have bought nothing measurable — there is no query above 7 ms to
tune.

## What changed

### Function region pinned to `fra1`

`vercel.json` did not pin a region, so functions landed in Vercel's default —
usually Washington DC — while the database sat in Frankfurt. Every query
crossed the Atlantic and came back.

One line, no code, and it is worth more than everything else on this page put
together: it turns a ~130 ms round trip into ~1 ms. `docs/DEPLOYMENT.md` already
said to put the database near Riyadh; nothing said to put the *functions* there
too, and they were not.

This does not make local development faster. A laptop in Pakistan is far from
Frankfurt whatever Vercel does. That is a development annoyance, not a
production one — the customers are in Riyadh.

### Settings read once, not per caller

`getSettings(keys)` used to run `select … where key in (…)` for whichever keys
the caller wanted. A single page render calls it three or four times — the page,
its data loader, and `sweepNoShows` — each with a different key list, so each
paid its own round trip and none could reuse another's answer. Hence 245 calls.

It now reads the whole table, about twenty rows, into a process-level cache with
a one-minute window, and picks keys out in memory. Every caller after the first
costs nothing.

**Why a plain `Map` and not `unstable_cache`.** The obvious answer is Next's
data cache, and it was written that way first. `next/cache` imports React's
server-only build, which throws the moment anything outside the Next runtime
loads it — and half of `scripts/check-*.ts` reaches this file through
`lib/bookings`. Choosing the framework cache would have taken the entire test
suite down to save four lines. The plain cache works in the app, in scripts, and
in tests, and it is the same shape `lib/throttle.ts` already uses.

**Why the staleness is safe.** Nothing writes the `settings` table outside the
seed — there is no admin screen for it. The only staleness possible is a
hand-edited row taking up to a minute to appear.

### Branches read once

Same problem, same fix, for the same reason: the shell layout reads the branch
list for the top bar on every admin page render, and `branchScope` reads it
again for the filter. Two round trips per page for a list that changes when the
company opens a third salon.

`lib/branches.ts` now holds one cached loader and all three callers use it.

### `/admin/bookings` stopped reading every add-on ever sold

The add-on lookup had no `where` clause. To label one day's bookings it read
every row in `booking_addons` — the salon's entire history — and threw away all
but the day on screen.

At seed size that is 8 calls at 0.1 ms and completely invisible, which is why it
survived this long. It is also linear in the salon's lifetime: it never gets
faster, only slower, and the day it becomes a problem is a day when nothing has
changed and everything is suddenly slow.

Now bounded by a subquery over the same branch and day the page already
filtered by. A subquery rather than a second `await` on the booking ids, so it
still runs beside the other reads instead of waiting a round trip for them.

`booking_addons` needs no new index for this: `booking_id` is already the
leading column of its composite primary key.

### Two indexes

The branch/time index cannot serve the two lookups that do not start from a
branch:

- `bookings(technician_id, starts_at)` — a technician's own day, the floor
  board, the commission figures
- `bookings(customer_id)` — `/my-bookings` and the refill window

Both are sequential scans without them. That costs nothing today and is not
free once the salon has a year of bookings behind it.

These are the *only* indexes added. It would have been easy to add six more on
the theory that indexes are good; the measurement says no query is slow, so
anything beyond these two would be decoration that slows every write down.

Note the migration uses plain `CREATE INDEX`, which holds a lock while it
builds. That is milliseconds on a table this size. If these tables ever get
large, a future index wants `CREATE INDEX CONCURRENTLY`, hand-written — drizzle
does not generate it, and it cannot run inside the transaction `drizzle-kit
migrate` wraps around migrations.

### The last two unthrottled endpoints

`lib/throttle.ts` already guarded sixteen routes. The two it did not cover were
the two that matter most:

- **`/api/availability`** — the heaviest public read there is, since a month
  view walks a month of bookings against every chair. Budget 60/min: a customer
  clicking through a calendar legitimately fires several a minute, and it is the
  scripted thousand this is here to stop.
- **`POST /api/bookings`** — the one write the public can reach without signing
  in, and the expensive kind. It opens a transaction that locks every chair at
  the branch while it reserves one, so an unbudgeted loop could hold the whole
  floor's lock and leave real customers unable to book. Budget 10/min: a real
  person books once and then pays.

## What was deliberately not done

**No Redis, no read replicas, no job queue, no cache layer in front of
Postgres.** Thousands of *users* is not thousands of *concurrent requests*. A
salon doing a thousand bookings a day peaks somewhere around 5–20 requests a
second, which this database handles without noticing. Every one of those
additions is a new thing that can fail at 3am, and none of them would have
fixed the missing `where` clause that was the actual defect.

**The no-show sweep still runs on page load.** 123 write transactions in the
session, one per admin page render. Throttling it would mean either breaking
`scripts/check-booking.ts`, which sweeps seven times in a row and asserts on
each, or adding a `force` flag that exists only so tests can opt out of a
performance feature. The sweep is an indexed `update` that matches zero rows
after the first pass, and once the functions sit next to the database it costs
about a millisecond. Revisit if it ever shows up in a measurement.

**Staff and time-off are not cached.** They are read on every front-desk render
and they look like the same easy win as settings. They are not: `offOn()` feeds
technician assignment, so a stale answer hands a customer to someone who went
home. Correctness beats a round trip.

**The throttle is still per-instance.** `lib/throttle.ts` counts in memory, so
with twenty warm instances a "10 per minute" budget is really 200. It is enough
to stop a script, which is what it is for. Moving it to a shared counter is a
new dependency and a new failure mode, and worth it only when the logs show a
real attempt.

**The station lock still serialises bookings per branch.** Reserving one chair
takes `select … for update` over every chair at the branch, so simultaneous
bookings there queue up. That is not a bug — it is what makes double-booking
impossible, and it is the hardest thing in the system to get right. The upgrade
path, when the queue is measurably hurting and not before, is a Postgres
exclusion constraint over `(station_id, time range)`, which lets the database
enforce non-overlap without an application-held lock.

## How to check whether any of this was worth it

Neon's dashboard has the same query insights table this document opens with. The
numbers to watch are the **call counts**, not the timings:

- `select id, name from branches` should now be a handful per instance per
  minute, not two per page render.
- `select key, value from settings` should be roughly the same.
- `select booking_id, name from booking_addons` should no longer appear without
  an `in (…)` clause.

If a query ever does show a real average — the `audit_log` insert at 7.2 ms is
the current leader and the only statement above 1 ms — that is the point at
which query tuning becomes the right tool. It is not the right tool today.

## Related

- `docs/DEPLOYMENT.md` — database region, and why it is on every page render
- `lib/throttle.ts` — the per-IP budgets and their known ceiling
- `scripts/_test-db.ts` — why the check scripts cannot reach production
