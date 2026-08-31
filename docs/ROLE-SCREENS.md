# Role screens and the salon floor — brief §3

Brief §3.1 (receptionist), §3.2 (technician) and §3.3 (admin), built together
because they are one flow seen from three chairs.

Part 1 explains what was built and why. Part 2 is the test guide: numbered,
runnable, in order.

---

# Part 1 — Walkthrough

## 1. What this actually is

Not "add RBAC" — RBAC has been in the codebase since P0. `lib/auth/rbac.ts` has
the capability matrix, `lib/auth/guard.ts` enforces it on every page and Server
Action, and the sidebar has always filtered by role.

What was missing was the other half: **a screen per role, and the floor flow
between them.** The panel showed everyone the same dashboard, and two roles
couldn't really use it.

## 2. The bug this started from

A technician could not sign in. `/admin` called `requirePage("dashboard.view")`,
technicians don't hold that capability, and the denial redirected to
`/admin?denied=…` — the same page, which denied them again.

Their sidebar was empty too: every nav item was gated on a capability they
lacked, including the only link pointing at a page they could open.

And `bookings.own` — the single capability a technician holds — was declared in
P0 and **never read by anything**. It is read now, in
`my-day/actions.ts`.

## 3. Roles: renamed, and re-drawn

`owner` → **`ceo`**, `manager` → **`admin`**. Same four roles, salon vocabulary.

The rename is a Postgres value rename, not a new type:

```sql
ALTER TYPE staff_role RENAME VALUE 'owner' TO 'ceo';
ALTER TYPE staff_role RENAME VALUE 'manager' TO 'admin';
```

`drizzle-kit generate` produces a `DROP TYPE` / `CREATE TYPE` pair for this,
which fails the moment a staff row already holds `owner` — the cast to the new
enum has nowhere to land. `drizzle/0008_role_rename.sql` is hand-written for
that reason, and says so at the top.

**Admin is not a renamed god mode.** Brief §3.3 moves the line in both
directions:

| | before (`manager`) | after (`admin`) |
|---|---|---|
| Manage the service list | ❌ | ✅ `catalog.manage` |
| Change a booking's timing | ✅ | ✅ — see the override below |

"Admin cannot change a booking's timing" is why `bookings.reschedule` is a
capability of its own rather than part of `bookings.manage` — admin needed
everything *else* that capability carries, so the two had to come apart.

**The salon overrode that clause on 2026-08-28.** An admin covering the front
desk could not move an appointment a customer was on the phone about, and asked
for it. `bookings.reschedule` is now held by the CEO, the front desk **and**
admin — everyone except technicians. The split capability is what made the
override one line rather than a refactor, and it is still what would make
reverting it one line.

This is the one place the code knowingly departs from brief §3.3. It is recorded
here, and in `lib/auth/rbac.ts` beside the grant, so that a later reader comparing
the two documents finds a decision rather than a bug.

## 4. One landing page, three screens

`/admin` now requires nothing beyond being signed in, and switches on role:

| Role | Sees |
|---|---|
| `ceo`, `admin` | the existing dashboard, unchanged |
| `receptionist` | the front desk |
| `technician` | their day |

That is what actually fixes the loop, and fixes it for every role at once: since
`/admin` can no longer deny anybody, `requirePage()`'s redirect there is safe
from anywhere. `dashboard.view` keeps its real job — gating the revenue
dashboard's *content*.

`NavItem.cap` became optional so the Dashboard link can be ungated. Without that,
a technician still gets an empty sidebar pointing at nothing.

## 5. The floor flow

```
   customer arrives, says "A12"
        │
        ▼
   RECEPTIONIST  /admin  — types A12, presses Check in
        │  status confirmed → checked_in
        │  stamps checked_in_at
        │  auto-assigns a free technician (or her override)
        │  emails the technician: ticket, station, time
        ▼
   TECHNICIAN  /admin  — the card is on her day, ringed red
        │  confirms the ticket number with the customer
        │  presses Start        → status in_progress, stamps started_at
        │  … does the service, a timer runs on the card …
        │  presses Finish       → stamps finished_at.  NOT completed.
        ▼
   RECEPTIONIST  /admin  — the row rises to the top, highlighted
        │  presses Close ticket → status completed
        └─ fires the rating email (brief §2.9), unchanged
```

### Why "Finish" is not "completed"

The technician saying she is done and the ticket being closed are two different
facts, and the brief gives them to two different people (§3.1: "End button to
close the ticket once the technician reports done").

Keeping them apart also protects the technician's number: her clock stops at
`finished_at`, whenever reception gets round to the paperwork. A slow front desk
cannot make her look slow.

This needed **no extra status**. `finished_at IS NOT NULL AND status =
'in_progress'` says "done, not yet closed" exactly, and saves a second enum value
and a second migration.

### Three timestamps, not `updated_at`

`checked_in_at`, `started_at`, `finished_at` are their own columns. `updated_at`
moves on every unrelated edit and would quietly corrupt a commission figure
months later.

| Interval | What it measures | Whose number |
|---|---|---|
| `checked_in_at` → `started_at` | how long she waited | the salon's |
| `started_at` → `finished_at` | the service itself | the technician's |

### Auto-assignment

`pickTechnician()` in `lib/assign/index.ts`: active, at this branch, and not
already holding a customer. Among those, fewest bookings today, so work spreads
instead of always landing on whoever sorts first.

Returns `null` when everyone is busy — check-in still succeeds, unassigned, and
the receptionist picks by hand. Refusing to check a customer in because the floor
is full would be worse than the problem it solves.

The decision itself is split out as a pure `chooseTechnician()` so
`scripts/check-roles.ts` can exercise the rule without a live Postgres.

> **Ceiling, marked in the code:** there is no roster or shift table, so
> "available" cannot mean "rostered on" — only "not mid-service". A shifts table
> is the upgrade path.

The busy check is deliberately *not* bounded to today or to this branch: a
booking stuck `in_progress` from yesterday is a real thing, and quietly handing
its technician a second customer is how it stays stuck.

## 6. The two new screens

**The technician's day.** Her own figures across the top — services finished,
average service time, against expected, total minutes worked — over Today / 7
days / 30 days. Same `loadTechnicianStats()` the CEO's screen calls, narrowed to
one technician, so nobody sees anyone else's numbers and no two screens can
disagree about an average. The period tabs change only the figures; the cards
below are always today, or "my day" would mean nothing.

Then one card per booking. The ticket number is the biggest
thing on it, because confirming it with the customer is the entire point of
pressing Start. Service, add-ons, design, chair, first name, notes — and **no
prices**, the same line the capability matrix draws. One button per card,
whichever the state calls for, and a timer against the service's expected
duration. No filters, no tabs, no drawer: a technician has wet hands and thirty
seconds.

**The front desk.** Three bands. Today's four counters on top. Then one big
autofocused ticket box that takes enter — and on a successful check-in clears
itself and refocuses, so a queue of two people needs no mouse. Then the day's
floor, with ready-to-close rows sorted to the top and highlighted.

The box matches **either the ticket number or the booking code** — `A12` or
`RON-4F2K`. The customer decides which one she reads out: the ticket is what the
salon calls across the floor, the code is what her confirmation email leads with.
A desk that took only one of them would fail half the time, for a reason the
receptionist could not see.

A pinned role gets no branch picker on Bookings. The data was always scoped by
`scopedBranchId()`, but the dropdown was still rendered — offering a choice that
changed nothing.

### No check-in before her slot

`checkin_early_min` in `lib/settings.ts`, default **0** — not before the
appointment time at all. The desk shows the customer, says when check-in opens,
and disables the button until then; `checkInTicket` re-checks server-side,
because a disabled button is a courtesy and not a rule.

This is not about tidiness. `pickTechnician()` counts a checked-in booking as
busy, so checking someone in an hour early **takes her technician off the floor
for that hour** — while customers who actually are due are told nobody is free.
It also charges the customer's own early arrival to the salon's waiting-time
figure, and counts someone sitting in reception as "in service now".

Raising the setting above zero allows a grace window (30 would mean "up to half
an hour early"). Late arrivals are never blocked — only the early side is
guarded.

Deliberately *not* done: blocking the technician's Start until the slot time. If
a chair is free at 13:40 and the customer is there, the salon wants to start.
The booking reserves a chair; it should not forbid using one that is free.

> **Ceiling, marked in the code:** the "notification" to the desk when a
> technician finishes is a highlighted row plus `router.refresh()` every 20
> seconds — polling, not push. Twenty seconds is well inside "she's still drying
> her hands". A websocket is the upgrade path if that stops being true.

## 7. Performance, and the money that isn't there

`/admin/performance`, gated on the new `staff.performance`. Per technician:
services finished, average service time, average against the service's expected
duration, average customer wait.

**No commission figures.** The client has not stated the rule, and a guessed
payroll formula is a dispute, not a feature. These are the numbers it will be
calculated from; when the rule arrives it is one function over them — no schema
change, no new screen. The screen says as much, on screen, in both languages.

Its own route rather than a tab on `/admin/staff`, because that page is staff
CRUD and folding an aggregate query into it tangles two unrelated things.

## 8. Per-staff monthly codes (§3.3)

"Each employee gets a unique code (e.g. 'Sara'), around 90%, once a month,
auto-renews, expires if unused."

Every one of those rules is already enforced by the promo engine — `percent`,
`max_uses = 1`, and a `starts_at`/`ends_at` window that lapses on its own. So a
staff code **is** a promo code. The only fact it adds is whose it is:
`promo_codes.staff_id`. No second table, no second set of rules to keep in step
with `lib/promo.ts`, and they already show up on `/admin/promo-codes`.

Two ways one gets issued, both through the same idempotent
`issueMonthlyCode()`:

- **on hire** — `saveStaff` issues one for the month the account was created in,
  wrapped so it can never fail the hire;
- **monthly** — `GET /api/cron/staff-codes`, guarded by `CRON_SECRET` exactly
  like the refill reminder. Not scheduled yet; add to `vercel.json` when the
  salon wants it live:

  ```json
  { "crons": [{ "path": "/api/cron/staff-codes", "schedule": "0 1 1 * *" }] }
  ```

Nothing deletes last month's code — an unused one lapses when its window closes,
which is what "expires if unused" means, and the row stays as a record of what
was offered.

The brief's "later linked to HR / government ID so it cannot be shared" is
explicitly a later phase. Not built.

## 9. Files

**New**

```
lib/assign/index.ts                     pickTechnician, chooseTechnician, notifyTechnician
lib/assign/email.ts                     the technician's "you have a customer" mail
lib/staff-codes.ts                      monthWindow, issueMonthlyCode, …ForEveryone
app/(admin)/admin/(shell)/my-day/       data.ts · actions.ts · MyDayView.tsx
app/(admin)/admin/(shell)/front-desk/   data.ts · actions.ts · FrontDeskView.tsx
app/(admin)/admin/(shell)/performance/  page.tsx · PerformanceView.tsx
app/api/cron/staff-codes/route.ts
scripts/check-roles.ts
drizzle/0008_role_rename.sql            hand-written
drizzle/0009_booking_checked_in.sql     alone in its file, on purpose
drizzle/0010_floor_timings.sql
```

`my-day/` and `front-desk/` hold no `page.tsx`, so they are modules rather than
routes — both render at `/admin`.

**Changed, worth knowing**

- `lib/auth/rbac.ts` — renamed roles, three new capabilities, admin's ceiling
- `app/(admin)/admin/(shell)/page.tsx` — `requireStaff()` and a role switch
- `bookings/actions.ts` — `setBookingStatus` stamps the timings, assigns, mails
- `components/admin/nav.ts` — `cap` optional; Performance added
- `lib/bookings.ts` — the no-show sweep's comment; its logic needed no change,
  since it keys off `status = 'confirmed'` and `checked_in` leaves that behind

## 10. Migrations

```bash
npm run db:generate   # only if you change the schema further
npm run db:migrate
```

`0009` contains one statement and must stay that way: Postgres will not let a
value added by `ALTER TYPE … ADD VALUE` be *used* in the transaction that adds
it, and Drizzle runs each migration in a transaction.

---

# Part 2 — Test guide

Run in order. Steps 1–3 are setup; from step 4 you are on the floor.

## 0. Before anything

```bash
npm run db:migrate
npm run check:roles     # pure; no database needed
npm run build
```

`check:roles` covers the capability matrix, the technician picker's rules, the
monthly code window, and — the bug this started from — that **every role has at
least one nav item and can reach `/admin`**.

## 1. Three accounts

Sign in as the CEO (the seeded `SEED_OWNER_EMAIL` account; its role is now
`ceo`). Go to **Staff** and create two accounts, each with a password and
**assigned to a branch**:

- one **Receptionist**
- one **Technician**

Check as you go: the role dropdown now reads CEO / Admin / Receptionist /
Technician. Creating each one should also mint a 90% promo code named after their
first name — confirm on **Discount codes**.

> In `next dev` the login screen is skipped and `lib/auth/guard.ts` signs you in
> as the CEO. To test the other two roles you need a production-mode run
> (`npm run build && npm start`) or to temporarily change the seeded account's
> role.

## 2. A technician can get in at all

Sign in as the technician.

- ✅ Lands on `/admin` showing **My day** — *this is the step that fails before
  this change*, with a redirect loop.
- ✅ The sidebar has exactly one item, Dashboard.
- ✅ No prices anywhere on the screen.

## 3. A receptionist lands on the desk

Sign in as the receptionist.

- ✅ Lands on `/admin` showing **Front desk**, ticket box already focused.
- ✅ Four counters across the top.
- ✅ Sidebar shows Dashboard, Bookings, Customers, Gift cards, Ratings — no
  Catalog, no Staff, no Performance.

## 4. Make a booking to work with

On the public site, book an appointment at the receptionist's branch and pay it
through (the fake gateway approves everything). Note the **ticket number** from
the confirmation.

## 5. Check her in

As the receptionist, type the ticket number and press enter. Then try it again
with the booking code (`RON-…`) — both must find the same booking.

- ✅ The booking appears: name, service, time.
- ✅ A technician dropdown, defaulting to *Assigned automatically*.

Press **Check in**.

- ✅ The box clears and refocuses.
- ✅ The row moves to *Waiting for technician*, with a technician's name against
  it.
- ✅ The technician's mail arrives with **ticket, station and time**. With no
  SMTP configured this is skipped silently rather than failing — check the server
  log.

Now type a nonsense number: ✅ "No booking with that number today at this
branch." Type a real code for a booking on **another day**: ✅ the same message,
because the desk is bounded to today. Type the same real one again: ✅ "She's
already checked in."

## 6. Start and finish

Sign in as the technician.

- ✅ The card is there, ringed, showing the ticket number large.
- ✅ It says *Confirm the ticket number with her before you start.*

Press **Start**.

- ✅ The card switches to a **Finish** button with an elapsed timer.
- ✅ The timer counts against the service's expected duration.

Wait a minute or two, then press **Finish**.

- ✅ The card becomes *Waiting for the front desk to close it*.
- ✅ No rating email yet — the ticket is still open.

## 7. Close the ticket

Back as the receptionist (or wait up to 20 seconds on an open front desk).

- ✅ The row has risen to the top and is highlighted, with a **Close ticket**
  button.

Press it.

- ✅ Status becomes Completed and the counter moves.
- ✅ **Now** the customer's rating email goes out — and only once. Press again on
  a re-opened booking and no second email is sent (`reviews_booking_unique`).

## 8. The numbers

As the CEO, open **Performance**.

- ✅ The technician is listed with 1 service.
- ✅ Average service time matches roughly what you waited in step 6.
- ✅ *Against expected* shows faster/slower against the service's duration.
- ✅ *Average wait* is the gap between your check-in and her Start.
- ✅ A line saying no money is shown because the commission rule isn't set.

## 9. Try to break it

This is the part that matters most.

1. **A technician acting on someone else's booking.** Sign in as the technician,
   open dev tools, and call the Start action against a booking belonging to a
   *different* technician. ✅ Refused. The capability alone is not the
   authorisation — `my-day/actions.ts` guards on `technician_id = user.id` in the
   WHERE clause, so the row count settles it.
2. **A technician changing a booking's timing.** As the technician, invoke
   `rescheduleBooking`. ✅ Refused — `bookings.reschedule` is the one booking
   capability they do not hold. As the CEO, the receptionist or an admin, the
   same call is allowed (see the §3 override; admin was refused here until
   2026-08-28).
3. **Direct URLs.** As the technician, visit `/admin/catalog`,
   `/admin/performance` and `/admin/audit`. ✅ All refused server-side and
   redirected to `/admin` — not merely hidden from the sidebar. ✅ And the
   redirect lands on their day, not on a loop.
4. **Double-press.** Press Finish twice fast. ✅ The first timestamp stands
   (`finished_at IS NULL` is in the guard), so the KPI keeps the honest number.
5. **A full floor.** Set every technician mid-service, then check someone in.
   ✅ Check-in still succeeds, unassigned, and the row offers a dropdown to pick
   by hand.
6. **The last CEO.** Try to demote or deactivate the only CEO account. ✅
   Refused — "The last CEO account cannot be deactivated."
7. **Early arrival.** Find a booking whose slot is later today. ✅ It shows,
   with "She's early — check-in opens at HH:MM", and Check in is disabled. Wait
   past the slot (or set `checkin_early_min` higher) and ✅ the button enables
   itself within 20 seconds, without re-searching.
8. **Branch scope.** As the receptionist, open Bookings. ✅ No branch dropdown —
   they are pinned to their own. Open Ratings. ✅ Only their branch's reviews.
   (Customers is deliberately *not* scoped: the desk needs to recognise a
   customer who normally visits the other branch.)
9. **A technician reading someone else's numbers.** As the technician, the stat
   row is hers alone. ✅ `/admin/performance`, which lists everyone, is refused.

## 10. Both languages

Toggle the panel to Arabic on each of the three screens. ✅ Every new label is
translated and the layout flips to RTL — the ticket box, the buttons, the
counters and the performance table included.
