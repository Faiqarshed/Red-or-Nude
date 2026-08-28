# Day-start assignment and days off — brief §3.1, §3.3

Who serves whom, decided before the salon opens instead of one customer at a
time at the front desk.

Part 1 explains what was built and why. Part 2 is the test guide: numbered,
runnable, in order.

---

# Part 1 — Walkthrough

## 1. What this actually is

At 07:00 Riyadh a job reads the day's confirmed bookings for each branch and
deals them out across the technicians who are in — evenly, and without landing
two overlapping appointments on the same person. By the time the first customer
arrives, every booking already has a name on it.

Three things follow from that, and they are the whole feature:

- a technician opens **My day** at opening time and sees her whole day, not an
  empty list that fills up as people walk in;
- the front desk can move a technician **before** the customer arrives, from a
  dropdown that now says who is busy and who is off;
- each technician is emailed shortly before each of her slots starts.

## 2. Where it was before

`setBookingStatus` picked a technician on the transition into `checked_in`, and
nowhere else. So `bookings.technician_id` was null all morning, My day was empty
until someone walked in, and the front desk's dropdown — which only rendered on
rows already checked in — listed every technician with no indication of who was
free.

`pickTechnician` also had no way to know who was actually working. Its own note
said so: *"there is no roster or shift table in the schema, so this cannot know
who is rostered off today — only who is mid-service."* That note is gone,
because `staff_time_off` is now that table.

## 3. The rule

One function decides, and both entry points call it — the morning run and
check-in cannot drift into balancing the floor by different rules.

`chooseTechnician(candidates, unavailable, load)`, unchanged from before:

1. candidates are active technicians at that branch, in a stable id order;
2. anyone **unavailable** is dropped — mid-service, or not in today;
3. of the rest, **fewest bookings today** wins; ties keep the given order;
4. nobody left → `null`, and the booking stays unassigned rather than doubling
   someone up.

`planAssignments` wraps it for a whole day: one pass in start order, where
"unavailable" also means *already holding a slot that overlaps this one*.
Intervals are half-open, so 10–11 and 11–12 stack on one technician the way
back-to-back appointments are meant to.

It is greedy and does not backtrack — a later booking can come back unassigned
where reshuffling earlier ones would have fitted it. For a floor of a handful of
chairs that is not a problem worth an interval solver, and the `ponytail:` note
in the source says when to revisit.

## 4. Automatic, but never in charge

The automation fills gaps. A person always outranks it, and that is enforced in
code rather than by convention:

1. **The run never overwrites a person.** `assignDay`'s query carries
   `technician_id IS NULL`, and so does the UPDATE. A name a receptionist put
   there is invisible to it. This is also what makes the job safe to re-run,
   safe to double-fire, and safe to run late.
2. **Check-in stands down.** `setBookingStatus` picks only when the booking does
   not already name someone, so the morning's assignment survives arrival.
3. **Any row, any time.** The dropdown is on every live row of the day, not just
   the checked-in ones, so the desk can move a technician before the customer
   arrives.
4. **Someone leaves — Today's team.** Marking a technician out is its own
   screen, §7 below. Her waiting customers *are* redistributed, immediately —
   see [LIVE-ASSIGNMENT.md](LIVE-ASSIGNMENT.md) §5 — but anyone already in her
   chair stays with her, and every name the run writes is one a receptionist can
   overrule afterwards.

To turn the automation off entirely, drop the entry from `vercel.json` — the
salon goes back to assigning at check-in exactly as it did before.

**Un-assigning is not on offer from the drawer.** A receptionist clearing a row
by hand would forge a signal she does not mean, so `assignTechnician` only ever
moves a booking **to** somebody. The two places that *do* empty a row —
rescheduling and sending a technician home — both re-deal it in the same breath,
so it is never left dangling.

**Whatever arrives after this run** is picked up within seconds rather than at
check-in: see [LIVE-ASSIGNMENT.md](LIVE-ASSIGNMENT.md), which re-runs `assignDay`
whenever the day changes underneath it. The desk and the check-in picker remain
the fallback behind both.

Every automatic write is audited like a manual one. `recordAudit` already
accepts a null actor id for mutations with no staff member behind them, so the
run logs its `assign-technician` rows under *Automatic assignment* and the trail
shows plainly which bookings a person assigned and which the job did.

## 5. Days off

`staff_time_off` — a staff id, a start date, an end date, an optional reason.
Dates only, inclusive at both ends, so the same value in both columns is one
day and one row covers a fortnight away just as well.

Deliberately **not** `closures`, which is branch-wide and shuts the whole salon
for Eid or maintenance. This is one person being elsewhere while the branch
trades as normal.

It lives in the existing staff drawer under **Days off**, shown only for
technicians — a receptionist's leave changes nothing any code reads. Native
`<input type="date">`, because the browser already renders a calendar in the
user's own locale and hands back exactly the `YYYY-MM-DD` the column stores.
Leaving the end date blank means one day.

`offOn(day)` compares against the Riyadh calendar day as a string, so there is
no timezone arithmetic and no midnight-UTC row silently covering the wrong day.
Both `assignDay` and `pickTechnician` use it.

## 6. "Busy" is a fact about a slot

What matters when moving a 17:00 booking is who is free **at 17:00** — not who
happens to be holding a customer while the receptionist looks at the screen.
Both dropdowns work that way: whoever is out today, or already booked across
those exact hours, is **greyed out** rather than merely annotated. A list where
everything is selectable and half the names carry a note leaves the receptionist
doing collision arithmetic at the desk with a customer in front of her.

`lib/slots.ts` holds that one rule — `overlaps` and `busyDuring` — and the
assignment engine, the front desk and Today's team all import it. Three places
deciding separately what "busy" means is how someone ends up greyed out on one
screen and handed a second customer by another.

## 7. Today's team — when a technician goes home

`/admin/floor`. One card per technician: whether she is in, how much she is
holding, and a **Send home** button.

Sending her home writes a one-day `staff_time_off` row, which is all it takes for
the morning run and the check-in picker to stop choosing her, and for both
dropdowns to grey her out. Her existing bookings stay on her, listed under her
card with a *Move to…* dropdown each — the desk hands them on one at a time.

Gated on **`bookings.checkin`**, not `staff.manage`. The person who knows someone
has gone home sick is the receptionist standing next to her, and making her phone
a manager means the automation keeps handing customers to somebody who left. That
is also why it is bounded to today: this screen writes one day and clears one
day, so *Bring back* cannot end somebody's booked holiday — it refuses, and says
to use Staff.

## 8. When mail goes out

Twice, never for the same booking:

- **before the slot** — `/api/cron/tech-reminders`, every quarter hour, mails
  anyone starting inside `assign_notify_min` (30 by default) and stamps
  `bookings.tech_notified_at`;
- **at check-in** — unchanged from before, for a walk-in nobody was expecting.

The first of those is **not in `vercel.json`**: Hobby allows no cron more often
than daily, and a `*/15` entry fails the whole deployment rather than being
ignored — which takes the morning run down with it. The endpoint is still there
and still guarded by `CRON_SECRET`; point any outside scheduler at it, or go
without and let check-in be the technician's first notice.

Check-in stamps `tech_notified_at` too, so a customer who arrives early never
costs her technician a second copy. The reminder job stamps *before* sending:
`notifyTechnician` never throws, so a failure there is one missing nudge, while
a failure after an unstamped send would mail the same person every quarter hour
until her customer arrived.

No new template — `renderAssignmentEmail` already said exactly this.

## 9. Files

| File | What changed |
|---|---|
| `lib/db/schema.ts` | `staff_time_off`; `bookings.tech_notified_at` |
| `drizzle/0012_green_captain_flint.sql` | the migration |
| `lib/assign/index.ts` | `offOn`, `planAssignments`, `assignDay`; time off in `pickTechnician` |
| `app/api/cron/assign-day/route.ts` | the morning run |
| `app/api/cron/tech-reminders/route.ts` | the "starting soon" mail |
| `vercel.json` | the morning schedule (see §8 for why the reminder job is not there) |
| `lib/settings.ts` | `assign_notify_min` |
| `app/(admin)/admin/(shell)/bookings/actions.ts` | stamps `tech_notified_at` at check-in |
| `app/(admin)/admin/(shell)/staff/*` | the days-off block |
| `lib/slots.ts` | `overlaps`/`busyDuring` — one definition of "busy" |
| `app/(admin)/admin/(shell)/floor/*` | Today's team: send home, hand her customers on |
| `components/admin/nav.ts`, `Sidebar.tsx` | the new tab |
| `app/(admin)/admin/(shell)/front-desk/*` | per-slot greying, dropdown on every live row |
| `lib/admin/strings.ts` | the new labels, both languages |
| `scripts/check-roles.ts` | the rule, asserted |
| `scripts/seed-day.ts` | `npm run seed:day` — a floor to test against |

## 10. Migrations

```bash
npm run db:generate   # already done — 0012_green_captain_flint.sql
npm run db:migrate
```

One new table and one new nullable column. Nothing is backfilled: yesterday's
bookings keep their null `tech_notified_at`, and the first run only ever looks
at today.

---

# Part 2 — Test guide

Run in order. Steps 0–2 are setup; from step 3 you are on the floor.

## 0. Before anything

```bash
npm run db:migrate
npm run check:roles     # pure; no database needed
npm run build
```

A `CRON_SECRET` in `.env.local` is what the two cron endpoints check for; without
one they refuse every request, including yours.

`check:roles` grew a block for `planAssignments` — the real function, not a mock
of it. It asserts the spread is even, that overlapping slots never land on one
person, that back-to-back ones may, that the surplus comes back unassigned
rather than double-booked, that an existing manual load is counted, that an
empty floor throws nothing, and that the caller's maps are not mutated.

## 1. Set up a day

```bash
npm run seed:day
```

Three technicians and a receptionist at the first branch (password `salon1234`,
or `SEED_STAFF_PASSWORD`), and six confirmed bookings, all unassigned — two of
them starting at the same moment, and a third overlapping the first, so the
rules about overlap have something to trip on.

The receptionist account is not a nicety: the front desk is what `/admin`
renders **for a receptionist**, and `next dev` signs you in as the CEO, who gets
the dashboard instead.

The times are **relative to when you run it**, starting at the next half hour.
That is not tidiness: `createBookings` runs the no-show sweep on its way in, so
a fixture written at a fixed 10:00 and seeded in the afternoon is marked
`no_show` before you can test anything with it.

Re-runnable. It deletes its own customers' bookings for today first, scoped to
that customer set, that branch and that day, so it cannot reach a real booking.

It prints the floor it ended up with — anyone already working at that branch
counts toward the spread too, so six bookings may well go four ways.

## 2. Give someone the day off

**Staff** → open a technician → **Days off** → today in *From*, leave *To*
blank → **Add days off**.

- ✅ The range appears as a single date, not a range.
- ✅ The audit log records it.
- ✅ The block does not appear at all for a receptionist or an admin.

## 3. Run the morning job

```bash
curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/assign-day
```

- ✅ `{ ok: true, branches: n, assigned: 6, unassigned: 0 }` — or an honest
  smaller count if the slots genuinely cannot all fit.
- ✅ Run it a **second time** → `assigned: 0`. Idempotent.
- ✅ Without the header → `401`.

## 4. Look at the floor

**Front desk**, before anyone has arrived:

- ✅ Every row shows a technician name — they were all blank before this change.
- ✅ The count is even across the two working technicians; the one on leave has
  **none**.
- ✅ No technician holds two overlapping slots.
- ✅ The dropdown renders on these not-yet-arrived rows.
- ✅ Options are marked `Sara · busy` and `Noura · off`, and the one who is off
  cannot be selected.

## 5. The technician's morning

Sign in as a technician — this needs `npm run build && npm start`, since
`next dev` signs you in as the CEO (see ROLE-SCREENS.md §1).

- ✅ **My day** lists her whole day at opening, before a single check-in.
- ✅ The technician on leave sees an empty day.

## 6. Manual control beats the machine

1. Change the technician on an unarrived row → re-run the cron.
   ✅ **Your pick survives.**
2. Open any row's dropdown. ✅ Whoever is already booked across **that row's
   hours** is greyed out, marked `· busy`; whoever is out today is `· off`.
   ✅ A technician on the *next* slot along is selectable — back-to-back is not
   a clash.
3. ✅ The first option, "Unassigned — booked later today", cannot be chosen.
   That state is the system's to produce, not yours.
4. **Audit log** ✅ shows `assign-technician` rows from both *Automatic
   assignment* and the receptionist by name.

## 6b. Someone goes home — Today's team

Open **Today's team** in the sidebar (as the receptionist, or any admin).

1. ✅ One card per technician, each showing today's booking count.
2. Press **Send home** on the busiest one. ✅ Her card is marked *Gone home*, and
   her still-ahead bookings list underneath with a *Move to…* dropdown each.
3. ✅ Each dropdown greys out whoever is busy across **that booking's** hours —
   so the same technician can be offered for one of her customers and refused
   for another.
4. Move one. ✅ It leaves her list and appears on the other technician.
5. Re-run the cron. ✅ Her remaining bookings are **not** touched — she keeps
   them until someone moves them, and nothing new is sent her way.
6. Press **Bring back**. ✅ She is in again and selectable everywhere.
7. As an admin, give her real leave under **Staff** covering today, then press
   **Bring back** on Today's team. ✅ Refused — "That is booked leave — change it
   under Staff." The desk cannot end somebody's holiday.

## 7. Check-in still behaves

- Check an assigned customer in. ✅ Her technician is **unchanged**.
- Un-assign someone, then check her in. ✅ The check-in picker takes over, and
  ✅ still skips whoever is on leave.

## 8. The mail

```bash
curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/tech-reminders
```

With a booking starting inside `assign_notify_min`:

- ✅ One mail — the log driver prints it when no provider is configured.
- ✅ Run again → `sent: 0`; `tech_notified_at` is stamped.
- ✅ Now check that customer in → **no second mail**.

## 9. Try to break it

1. **Every technician off today.** ✅ The run assigns nothing and returns
   cleanly. The floor falls back to manual and check-in still works unassigned.
2. **A booking created after the run.** Book a same-day slot. ✅ No technician
   until either the button is pressed or she checks in; neither path errors.
3. **Two runs at once.** Fire the cron twice in parallel. ✅ Nobody is
   double-assigned — the UPDATE is conditioned on `technician_id IS NULL`, so
   whoever writes second changes nothing.
4. **A day off added mid-morning**, after assignment. ✅ Her existing rows stay —
   silently stripping assigned customers off a live floor would be worse than
   the problem. ✅ She is excluded from the next run and from check-in picks.
5. **A booking stuck `in_progress` from yesterday.** ✅ Its technician still
   counts as busy, deliberately, and both entry points respect that.
6. **A backwards range.** Add days off ending before they start. ✅ Refused —
   "The end date is before the start date."
7. **Another branch's technician.** Call `sendHome` with an id from the other
   branch. ✅ Refused — the desk sends home its own floor and no other.
8. **Send home twice.** ✅ The second press is a no-op, not a second row that
   would need bringing back twice.
9. **A pending (unpaid) booking.** ✅ Never assigned — a hold that may never
   become a booking must not take a technician off the floor.

## 10. Both languages

Toggle the panel to Arabic. ✅ The days-off block, the busy/off markers, the
un-assign label and the *Send home* / *Move to…* controls are all translated
and flip to RTL.
