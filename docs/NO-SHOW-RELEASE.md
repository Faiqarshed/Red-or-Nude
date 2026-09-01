# No-show release and staff follow-up

If nobody checks a customer in within 20 minutes of their slot, the chair is
released automatically and a walk-in can have it. The customer who missed it is
flagged for staff, and the flag stays until someone says it is handled.

Part 1 is what was built and why. Part 2 is a test guide you can run at the
keyboard.

---

# Part 1 — Walkthrough

## The problem

A customer pays up front and holds a chair for the whole appointment. If they
never turn up, that chair sits empty while walk-ins are turned away — the salon
loses the slot twice, having already been paid for it once.

## How a chair gets released

`sweepNoShows(branchId)` in [lib/bookings.ts](lib/bookings.ts), one
statement:

```sql
update bookings
   set status = 'no_show', no_show_at = now(), updated_at = now()
 where branch_id = $branch
   and status = 'confirmed'
   and no_show_at is null
   and starts_at >= $dayStart
   and starts_at <  now() - make_interval(mins => $grace)
```

Setting the status **is** the release. `bookings_station_slot_unique`,
`reserveStations` and the availability engine's conflict scan all already
excluded `no_show`, so no scheduling code changed at all.

Each clause earns its place:

| Clause | Why |
|---|---|
| `status = 'confirmed'` | `in_progress` and `completed` mean the customer arrived |
| `no_show_at is null` | Idempotent — the sweep runs on every page load and must not keep moving the timestamp |
| `starts_at >= dayStart` | Today only — history is not something to release a chair for |
| `< now() - grace` | The 20 minutes |

Modelled on `sweepExpiredHolds` right above it, which does the same job for
unpaid holds: no cron, run lazily by the things that care. Three call sites, each
a moment the day has to be current:

- `createBookings` — so a walk-in being written sees the freed chair;
- `GET /api/availability` — so the walk-in drawer's grid is right on a page left
  open since morning;
- the admin bookings page — so the flag appears.

`ponytail:` note on it, same as its sibling — a page nobody opens keeps its
chairs held, and a cron replaces this if that ever matters.

## The uncomfortable part, and what was done about it

**`confirmed` does not currently mean "customer absent". It means "nobody
clicked".** The codebase says so itself, in
[app/(site)/station/[token]/page.tsx](<app/(site)/station/[token]/page.tsx>):

> `in_progress` is the receptionist having pressed Start; `confirmed` covers the
> far more common case of nobody having got round to it — the customer is sitting
> there either way.

So on day one this will flag people who were served. Three things make that
survivable, and they are why the design looks the way it does:

1. **Today only.** Switching this on cannot flag months of untouched history,
   because history is not today.
2. **Releasing is not taking.** The booking row is untouched — same ticket, same
   price, same customer. The chair only actually changes hands if a walk-in
   claims it, and until then the customer can still sit down.
3. **One button clears it.** A wrongly flagged booking is resolved in a click,
   with a note saying what really happened.

It still means **staff have to start marking arrivals.** The cheap nudge:
the drawer's `confirmed → in_progress` button now reads **Check in**. Only the
button — the status badge still reads *In progress* — because pressing it is now
what the 20-minute rule measures, and "Check in" says that where "In progress"
does not.

## Why walk-ins now ignore the lead time

`booking_lead_time_min` was 60 when this was written (it is 0 now — see
docs/CANCEL-RESCHEDULE-ADDON.md), and the walk-in drawer used the same availability
engine as the public site. So a chair freed at 14:20 could not be given to
anyone: the 14:00 slot is past and 14:30 is inside the hour. The feature would
have released chairs nobody could use.

`getDayAvailability` gained a `leadTimeMin?` override and
`GET /api/availability` accepts `walkIn=1`, which sets it to `0`. A walk-in is
someone standing at the desk right now; "book at least an hour ahead" is a web
rule that was always backwards at the counter.

**It is staff-gated.** The route is public, so `walkIn=1` is honoured only when
`currentStaff()` returns someone — otherwise anyone could book a slot starting
five minutes from now. The flag is also parsed as a literal `"1"`, not
`z.coerce.boolean()`, which would have treated `walkIn=0` as true.

Worth knowing: `createBookings` never enforced lead time itself — only the slot
grid hid those times — so this is a display fix plus a guard, not a change to the
booking rules.

## What "resolved" records

Three columns on `bookings`:

| Column | Meaning |
|---|---|
| `no_show_at` | When the sweep released the chair. Null = never auto-flagged |
| `no_show_resolved_at` | When staff cleared it. Null = still needs someone |
| `no_show_note` | Optional, whatever they typed |

Unresolved is `no_show_at is not null and no_show_resolved_at is null` — no
boolean duplicating what a timestamp already says. A `no_show` a receptionist set
by hand has a null `no_show_at` and never appears in the strip, which is right:
someone was already dealing with it.

**There are no named outcomes, deliberately.** Nobody knows yet how a missed
customer actually gets settled — refunded, squeezed in later, rebooked, nothing.
A fixed list guessed now is a dropdown everybody sets to "Other". Once there are
a few weeks of real notes, the common answers become buttons and this same column
holds them.

**Nothing here touches money.** `refundBookings` is not called, no `refunds` row
is written, `payments` is untouched. Whether a missed customer gets their money
back is a decision made at the desk.

`resolveNoShow` is guarded on `no_show_resolved_at is null` as well as the id, so
two receptionists clearing the same row cannot overwrite each other's note — the
second gets `already-resolved`.

## Where it shows

An amber strip above the date toolbar on `/admin/bookings`, one row per
unresolved flag: date, time, customer, a `tel:` link, service, and **Resolve**.
Styled after the `?denied=` banner on the dashboard, the only other "pay
attention" surface in the admin.

**Not date-scoped.** A Friday no-show is still there on Monday — an unresolved
flag that vanishes when someone changes the date is not a flag, it is a rumour.

The note is asked for with `window.prompt`, exactly as the drawer already does
for a cancellation reason. Dismissing the prompt still resolves the row with no
note: the note is optional, and cancelling means "nothing to add", not "changed
my mind". Resolved notes show in the booking drawer afterwards.

## The bound that was removed

An earlier version also refused to flag anything that started more than four
hours ago, reasoning that a released chair stops mattering by evening. That is
true of the chair and wrong about the point.

**The flag is not about the chair. It is about a customer who paid and was not
served.** She is owed an answer whether staff open this screen at 11am or at
closing. The narrow window protected nobody — it silently dropped anyone whose
no-show happened during a stretch when nobody looked at the page, and they never
appeared in the strip at all.

It was also redundant against the one thing it was credited with. `starts_at >=
dayStart` was already there, so turning the feature on could never have flagged
old records regardless. Do not add it back.

**One hole that remains:** the sweep is lazy — it runs when someone opens the
page or makes a booking. A booking whose grace passes late in the evening, with
nobody opening the admin again before midnight, is never flagged: the next day it
falls outside the day bound. Narrow, but real. The fix is the cron the
`ponytail:` note already points at, which would run the sweep on a schedule and
close it.

## What was deliberately not built

- **No dashboard card.** A second surface to keep in sync for a number the
  bookings screen already shows in full.
- **No cron.** The lazy sweep matches the house pattern and needs no infra. If
  the salon ever wants chairs released with nobody watching the screen, the
  function is already the right shape to call from a schedule.
- **No `arrived_at` column.** `in_progress` is the arrival record. A second
  timestamp saying the same thing is a second thing to keep in sync.
- **No customer-facing notice.** A missed customer is not emailed. Staff deal
  with them, which is the whole point of the flag.

---

# Part 2 — Test guide

Assumes `npm run dev`, a seeded database, and `npm run db:migrate` applied
(`0006` adds the three columns and a partial index).

## 0. Automated first

```bash
npx tsx --conditions=react-server scripts/check-booking.ts
```

Six no-show assertions run near the end. All should print ✓:

```
no-show: 30 min past start, not checked in -> chair released ✓
no-show: sweeping twice keeps the original flag ✓
no-show: 5 min late is left alone ✓
no-show: checked in -> never released ✓
no-show: still flagged hours later ✓
no-show: yesterday is left alone ✓
no-show: freed chair is immediately rebookable ✓
```

The grace is a setting, `no_show_grace_min`, default 20. There is still no
`/admin/settings` screen, so change it by hand if you want to:

```sql
insert into settings (key, value) values ('no_show_grace_min', '20'::jsonb)
on conflict (key) do update set value = excluded.value, updated_at = now();
```

## 1. The 20 minutes

1. Book and pay for anything through `/booking`. Note the reference and chair.
2. Drag it into the past:
   ```sql
   update bookings
      set starts_at = now() - interval '25 minutes',
          ends_at   = now() + interval '20 minutes'
    where code = 'RON-XXXXX';
   ```
3. Open `/admin/bookings` (today's date).
   - **Expect:** the booking is now `no_show`, gone from the day grid, and an
     amber strip has appeared at the top with its row in it.
   - Check the columns:
     ```sql
     select status, no_show_at, no_show_resolved_at from bookings where code = 'RON-XXXXX';
     -- no_show | a timestamp | null
     ```

## 2. The point of it — a walk-in takes the chair

With that booking still flagged:

1. On `/admin/bookings`, press **Walk-in**.
2. Fill in a phone and pick a service.
   - **Expect:** times from **now onward** are selectable, including the next
     half-hour. Before this change nothing inside 60 minutes was clickable.
3. Create it.
   - **Expect:** it lands on the chair the no-show was holding. Confirm with:
     ```sql
     select code, station_id, starts_at, status from bookings
      where branch_id = '<branch>' order by created_at desc limit 2;
     -- the walk-in and the no-show share a station_id
     ```

Note the released slot is claimable **from the next slot boundary**, not
retroactively — you cannot start a 14:00 appointment at 14:20. The chair is free;
the clock still applies.

## 3. The safety case — a checked-in customer is never touched

This is the one that protects real customers.

1. Book and pay again. Open it in the drawer and press **Check in**.
   - **Expect:** status becomes *In progress*.
2. Drag it far into the past:
   ```sql
   update bookings set starts_at = now() - interval '90 minutes' where code = 'RON-YYYYY';
   ```
3. Reload `/admin/bookings`.
   - **Expect:** still *In progress*, still on the grid, **not** in the strip,
     and `no_show_at` is null. However late it is, a checked-in customer is never
     released.

## 4. Boundaries

| Set up | Expect |
|---|---|
| `starts_at = now() - interval '5 minutes'` | Untouched. Five minutes late is late, not absent |
| `starts_at = now() - interval '5 hours'` | **Flagged.** A morning no-show is still owed an answer in the afternoon |
| `starts_at = now() - interval '26 hours'` | Untouched — yesterday is history |
| `starts_at = now() - interval '25 minutes'`, status `completed` | Untouched. They came and were served |
| Reload the page repeatedly on a flagged booking | `no_show_at` never changes. The sweep is idempotent |
| A booking marked `no_show` by hand from the drawer | Never appears in the strip — `no_show_at` stays null |

## 5. Resolving

1. In the strip, press **Resolve** and type a note.
   - **Expect:** the row leaves the strip. Open the booking in the drawer — the
     note shows as *Resolution note*.
   ```sql
   select no_show_resolved_at, no_show_note from bookings where code = 'RON-XXXXX';
   ```
2. Repeat on another flagged booking, but **dismiss** the prompt.
   - **Expect:** it still resolves, `no_show_note` is null.
3. Check the audit trail:
   ```sql
   select actor_name, action, diff from audit_log
    where action = 'resolve-no-show' order by created_at desc limit 1;
   ```
4. **Confirm no money moved** — this matters:
   ```sql
   select * from refunds r join payments p on p.id = r.payment_id
    where p.booking_id = '<the booking id>';
   -- no rows. payments.status is whatever it was before.
   ```

## 6. The false flag — the case you will actually hit in week one

Staff forget to check someone in, the customer is served anyway, and the system
flags them.

1. Book, pay, and simply do not touch it. Drag it 25 minutes into the past.
2. Let it get flagged.
3. Press **Resolve** with the note `was served, forgot to check in`.
   - **Expect:** cleared, note recorded, no money moved, nothing else changed.

If this is happening often, that is the signal that staff are not using
**Check in** — the number of flags is the measure of it.

## 7. The staff gate on the lead time

```bash
# Signed out — walkIn=1 must be ignored, near slots still hidden
curl -s "localhost:3000/api/availability?branchId=<id>&date=<today>&duration=45&walkIn=1" \
  | python -c "import json,sys; s=json.load(sys.stdin)['slots']; print(sum(x['available'] for x in s), 'available')"
```

Compare with the same call **without** `walkIn=1` — signed out the two must match
exactly. Signed in to the admin in a browser, the walk-in drawer should show more
slots than the public booking page does for the same day.

## 8. Regression

- [ ] A normal web booking may now be made right up to the slot itself — the
      lead time is 0. Restore it to 60 to re-test this row as written
- [ ] `npx tsx --conditions=react-server scripts/check-booking.ts` passes
- [ ] `npm run check:cancel` and `npm run check:fields` pass
- [ ] `npm run build` is clean
