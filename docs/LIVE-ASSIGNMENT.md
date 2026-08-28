# Live technician assignment — brief §3.1

The 07:00 run deals out the day. This is what happens to everything that
arrives *after* it — and what happens when the day it dealt stops being true.

Part 1 explains what was built and why. Part 2 is the test guide: numbered,
runnable, in order.

Read [DAY-START-ASSIGNMENT.md](DAY-START-ASSIGNMENT.md) first. This is a layer
on top of it, and reuses its rule wholesale.

---

# Part 1 — Walkthrough

## 1. The gap

At 07:00 Riyadh the cron reads each branch's confirmed bookings for the day and
gives every one of them a technician. Before this change, that was the only
thing that ever did so ahead of time. Everything after 07:00 fell through to one
of two places:

- **check-in** — `setBookingStatus` picks a technician when the customer walks
  up to the desk;
- **the receptionist** — she notices an empty row and assigns by hand.

Which means a customer who booked at 10 a.m. for 4 p.m. had no name against
their appointment for six hours. **My day** did not show it. The desk's floor
screen did not show it. Nobody found out the floor was short until the customer
was standing there.

The client's words for what they wanted: *fully automated, keeping the manual
control*. The automation had a hole in it exactly one working day wide.

## 2. One function, four callers

Everything here is this:

```ts
// lib/assign/index.ts
export async function assignIfToday(branchId: string, day: Date): Promise<void> {
  if (!isToday(day)) return;

  try {
    await assignDay(branchId);
  } catch (err) {
    console.error(`[assign] live run failed for branch ${branchId}`, err);
  }
}
```

It re-runs the morning job. That is the entire design, and it works for one
reason: **`assignDay` only ever fills empty rows.** Its SELECT carries
`technician_id IS NULL` and so does its UPDATE. Re-running it cannot take a
customer off anybody, cannot undo a receptionist's decision, and cannot do
anything twice. A function with that property is safe to call from anywhere, so
there was no reason to write a second, narrower one.

The alternative — a bespoke `assignBooking(id)` that staffs exactly one row —
would have been a second copy of the rule that has to be kept in step with the
first. The codebase already refuses that trade one level down: `chooseTechnician`
is shared between the morning run and check-in *precisely* so the floor is never
balanced by one rule at dawn and a different one at noon. This is the same
argument, one level up.

Four places call it:

| When | Where | Why |
|---|---|---|
| A booking is paid for | `lib/payments/confirm.ts` | It is real work now. `pending` is an unpaid hold and must not take a technician off the floor. |
| A booking is cancelled | `app/api/my-bookings/cancel/route.ts` | A chair *and* a technician just came free. Anything left over may now be staffable. |
| A booking is moved | `lib/bookings.ts` → `rescheduleBooking` | The technician was free at the old time. At the new one she may not be. |
| A technician goes home | `app/(admin)/…/floor/actions.ts` → `sendHome` | Her waiting customers need somebody else, now. |

The reschedule call sits inside `rescheduleBooking`, which the customer's route
and the admin action already share — so a staff-side move gets the same
treatment without a second call site.

## 3. Why only today

`isToday(day, now)` compares Riyadh calendar days, and `assignIfToday` returns
early for anything else. That is a deliberate limit, not an oversight.

An assignment made three days ahead cannot see who will be on leave by then.
And nothing would ever revisit it, because **filling the row is exactly what
stops the dawn run looking at it again.** An early guess would therefore stick,
and on the morning of the appointment the salon would open with a name against a
booking whose technician is not in the building.

So tomorrow's floor stays the dawn run's job, on the day, when it can see the
roster as it actually is.

The comparison is against the **Riyadh** day, not UTC. Riyadh is UTC+3, so
between 21:00 and 24:00 UTC the two disagree — a booking taken at 00:30 local
for 8 a.m. that same morning falls on the previous UTC date. Written naively
this mis-assigns three hours out of every twenty-four, and does it silently.
That is what the four assertions in `scripts/check-roles.ts` pin down.

## 4. The bug underneath it

Building this surfaced a latent bug that had to be fixed first, or the feature
would have been wrong on its most important case.

`assignDay` builds a picture of who is already committed:

```sql
-- before
WHERE branch = ? AND starts_at IN today AND technician_id IS NOT NULL
```

A **cancelled** booking still carries a `technician_id`. So does a **no-show**.
Both matched, and both blocked that technician's hour for the rest of the day —
even though the customer is not coming and she is standing free.

This never mattered while assignment happened once, at dawn, before anyone could
cancel. It matters enormously the moment the job runs *because* someone
cancelled. Without the fix, the single most valuable case — *a slot frees up,
someone else books it, do they get a technician?* — would have answered **no**,
and the freed technician would have sat idle all afternoon.

The fix is one clause:

```sql
-- after
… AND technician_id IS NOT NULL AND status NOT IN ('cancelled', 'no_show')
```

`lib/bookings.ts` already excludes exactly those two statuses from the refill
window, for the same underlying reason: a cancelled booking hands everything
back.

## 5. Sending a technician home

`sendHome` used to write a one-day `staff_time_off` row and stop. Her booked
customers stayed on her, on purpose — the old comment said stripping a live
floor would lose the receptionist's place.

That reasoning held only while there was nothing to hand them *to*. Now there
is, so the action does both halves in one breath:

1. empty her waiting rows — `confirmed`, starting from now to closing;
2. write the time-off row;
3. `assignIfToday`, which deals those rows to whoever is still in.

The order matters at step 2/3: the time-off row is written **before** the run,
or the run would hand her own customers straight back to her. The release goes
first so that a second press still tidies up even though it writes no second
time-off row.

**`checked_in` and `in_progress` are deliberately excluded.** That customer is
sitting in front of her right now, and moving them would put a lie on a screen.

A second press still releases, even though it skips writing a duplicate
time-off row — otherwise a technician already on leave from the Staff screen
could be "sent home" with her customers left stranded on her.

## 6. Rescheduling

`rescheduleBooking` now sets `technician_id = NULL` inside the same transaction
that moves the time and the chair, then calls `assignIfToday` for the new date.

Keeping the old technician was not an option: she was free at 2 p.m., and there
is nothing whatsoever to say she is free at 5 p.m. A name that is now
double-booked *looks* like a decision and *is* a clash. Emptying the row hands
it to the only thing that actually checks.

A move to a later day empties the row and leaves it empty — which is correct,
and is that morning's run's job.

Only the destination day is re-dealt. Moving a booking *off* today does free its
old hour, but nothing re-runs for it — the next cancellation or payment at that
branch will, and until then the surplus sits on the desk's screen as it does
now.

## 7. What this deliberately does not do

- **No overselling fix.** Slot capacity is counted in **chairs**, not
  technicians (`lib/availability.ts`). Five chairs and two technicians sells
  five slots. That is a business decision — the salon may want a chair free for
  a walk-in, or may want to hire — and the software's job is to make it visible,
  not to override it. The surplus comes back unassigned and the front desk sees
  it.
- **No scheduled retry of old unassigned rows.** §4's fix means a cancellation
  *does* re-run the day, so nulls left over from earlier get picked up then.
  What does not exist is a background sweep hunting for them.
- **Nothing about no-shows.** Assignment already ignores them correctly, via
  `status = 'confirmed'`.
- **No change to the cron.** `vercel.json` is untouched. The Hobby plan's one
  daily cron still fires between 07:00 and 08:00 Riyadh and still does the bulk
  of the work; this only covers what arrives afterwards.
- **No email on live assignment.** The dawn run does not mail either — the
  quarter-hourly reminder job does, off `tech_notified_at`, and it picks these
  up like any other.

---

# Part 2 — Test guide

## 0. Setup

```bash
npm install
npm run db:migrate      # no new migration — this change touches no schema
npm run db:seed         # needs at least two technicians at one branch
```

The seeded Riyadh branch has five technicians and five chairs, which is what
makes step 3 below interesting.

## 1. The pure rules — no database

```bash
npm run check:roles
```

Covers the assignment rule as a whole, plus the four new assertions about which
day counts as today. The two that matter:

- `2026-08-30T05:00Z` **is** today when now is `2026-08-29T23:00Z` — two UTC
  days, one Riyadh day;
- `2026-08-30T21:00Z` is **not** today when now is `2026-08-30T12:00Z` — one UTC
  day, two Riyadh days.

Expected: `check:roles — all role, assignment and staff-code checks passed`

## 2. The database rules — live Postgres

```bash
npm run check:assign
```

This one writes to whatever `DATABASE_URL` points at, and deletes everything it
made on the way out, failure included. **Never run it against a real salon.**

Expected:

```
branch c8c91b21

1. paid for after the run     assigned to 49d883fd   PASS
2. booked for tomorrow        still unassigned         PASS
3. 8 booked for one hour     5 assigned, 3 left over   PASS
4. one of them cancels        surplus takes c241ec2b   PASS
5. technician sent home       c241ec2b → 1330daa4   PASS

check:assign — five live checks passed against Postgres
cleaned up 11 bookings, 1 time-off rows
```

Check 3 is the one that proves nobody is double-booked: eight overlapping
bookings against a smaller floor, every assigned name distinct, and the surplus
left for the desk rather than doubled up.

## 3. Prove check 4 is real

The most valuable assertion in the file is the one nothing else can reach. Break
the fix and watch it catch you:

```bash
# in lib/assign/index.ts, delete the notInArray line from assignDay's `taken` query
npm run check:assign
```

Expected — the surplus stays unassigned, because a cancelled row is still
holding a technician hostage:

```
4. a cancelled booking stops blocking its technician
+ actual - expected
+ null
- 'c241ec2b-…'
```

Put the clause back. This is the whole reason `check:assign` exists.

## 4. By hand — a booking paid for after 07:00

1. `npm run dev`, open `/booking`.
2. Pick **today**, any time later than now, and pay.
3. Open `/admin/bookings`, or **My day** as the assigned technician.

Expected: the new booking already has a technician against it, before anyone has
checked in. Confirm `/admin/audit` shows an `assign-technician` row under
**Automatic assignment**.

## 5. By hand — a booking for a future day

Repeat step 4, but pick **tomorrow**.

Expected: **no** technician. It stays empty until tomorrow's 07:00 run. This is
the guard from §3, and a name appearing here means `isToday` is comparing the
wrong thing.

## 6. By hand — a cancellation frees the floor

Needs a full hour: book every chair for one overlapping hour today, then one
more booking than there are technicians.

1. The surplus booking shows **unassigned** — correct, the floor is full.
2. Cancel any one of the assigned bookings from `/my-bookings`.
3. Reload `/admin/bookings`.

Expected: the surplus booking now holds the cancelled one's technician. Before
the §4 fix, it stayed empty.

## 7. By hand — a reschedule

1. Note the technician on a confirmed booking for later today.
2. Move it — from `/my-bookings`, or from the admin drawer — to another time
   today.

Expected: a technician is assigned at the new time, quite possibly a different
one. Never the old one purely by inheritance: the row is emptied first and
re-picked against the new hour.

Move it to **next week** instead, and expect it to come back **empty**.

## 8. By hand — sending a technician home

1. `/admin/floor`, with a technician who holds two or more later bookings today.
2. One of them checked in or in progress; the rest merely confirmed.
3. Press **Send home**.

Expected:

- she is greyed out in both dropdowns;
- her **confirmed, not-yet-started** bookings now show **other** technicians;
- the customer already with her **stays with her**;
- `/admin/audit` shows one `send-home` row, whose diff carries `released` — how
  many of her bookings were handed on.

Press **Send home** a second time. Expected: no error, no duplicate time-off
row, nothing stranded. The release runs before the row is written, so a second
press still tidies up; it writes no second audit row, because it releases
nothing.

Press **Bring back**. Expected: she is available again. Her old customers do
**not** return to her — they belong to whoever has them now, which is the
correct outcome and the reason the release is audited.

## 9. Regressions worth a look

| Check | Expected |
|---|---|
| Pay for a booking while the gateway is slow | Assignment happens after the money and after the ticket number; a failure to assign never fails a payment — `assignIfToday` swallows and logs. |
| Two guests booked together, one bill | One `assignIfToday` covers both. They overlap, so they must get **different** technicians. |
| Cancel a booking at a branch with no technicians at all | No error. `assignDay` returns `{ assigned: 0 }` and the desk assigns by hand. |
| A booking `in_progress` from yesterday | Still blocks its technician, unchanged — `pickTechnician`'s unbounded busy query is untouched. |
| The 07:00 cron | Unchanged behaviour, now simply with less left to do. |
| Manual assignment from the admin drawer | Survives everything here. Nothing in this change overwrites a non-null `technician_id`. |
