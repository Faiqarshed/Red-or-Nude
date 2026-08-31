# PR #13 review — the nine issues, in plain words

Review left by @Faiqarshed on 2026-08-31 against `feat/ai-chatbot`. Each item
below was checked against the code before being written down here; all nine
hold. **1 and 3-8 are fixed**; **2 is closed as unreachable**; **9 is a documentation
fix, decided**.

Severity, shortest version: **1 and 2 corrupt data.** **4, 6 and 7 give wrong
answers or lose records.** **3, 5 and 8 are UI dead ends.** **9 is docs.**

---

## 1. Two customers can get the same nail technician at the same time

**Fixed.** `assignDay` now takes a `pg_advisory_xact_lock` per branch and does
its read, plan and write inside one transaction. `scripts/check-assign.ts`
check 6 covers it — see `docs/LIVE-ASSIGNMENT.md` §3.

**File:** `lib/assign/index.ts:344`

The function that hands out today's bookings reads the database ("who is
free?"), decides in memory ("give Sara this one"), then writes.

The write says *only write if this booking still has nobody*. It never says
*only write if Sara is still free*.

That was fine when the run only happened once a day at 7am — one dealer, no
competition. This PR runs it whenever someone pays, opens My Bookings, or a
technician is sent home, so two copies can run at the same instant, both read
"Sara is free", and both write. Each write passes its own check, because the two
runs are checking *different bookings*, and both bookings were empty.

- 2:31:07pm — Noura pays for a 4:00pm gel manicure.
- 2:31:07pm — Layla pays for a 4:15pm pedicure at the same branch.
- Dealer A: Sara has the fewest bookings and is free at 4. Sara → Noura.
- Dealer B, before A has written: Sara has the fewest and is free at 4:15.
  Sara → Layla.
- Both writes succeed. Sara now holds two overlapping appointments.

`scripts/check-assign.ts` (check 3) exists specifically to catch this, so the
project already treats it as a rule that must never break.

The comment at that line says "two runs firing at once must not both win" — it
is guarding the wrong thing. It stops two runs fighting over one booking, not
one technician being given two.

**Fix:** one lock per branch so only one dealer runs at a time, or re-check the
technician's actual hours at the moment of writing.

---

## 2. Rescheduling a finished appointment erases who did it, forever

**Not fixed — deliberately, and nothing to fix yet.** No screen can move a
booking past `confirmed`. The customer's route refuses anything outside
`pending`/`confirmed`, and the admin's `rescheduleBooking` action has no button
on it — no `.tsx` file imports it. The reviewer's receptionist dragging a
finished booking to a new slot is describing a UI that does not exist.

The guard was written, then removed: code that cannot run is code nobody
maintains, and it read as if the danger were live. `docs/LIVE-ASSIGNMENT.md` §6
records what to add on the same commit as the reschedule button.

**File:** `lib/bookings.ts:983`

When a booking moves to a new time the technician is cleared — sensible, since
she may be busy at the new time. The dealer is then supposed to fill it back in.

The dealer only looks at bookings whose status is `confirmed`. Anything further
along — `checked_in`, `in_progress`, `completed`, `no_show` — is invisible to
it. Meanwhile the admin reschedule button has no status check at all, on
purpose: its own comment says the salon can move an appointment whenever it
needs to.

- Fatima had a pedicure yesterday. Status `completed`, technician Sara.
- Today the receptionist notices the wrong time slot and drags it to the right
  one.
- The technician field is cleared.
- The dealer skips the row, because it is not `confirmed`.

Sara's name is gone from a job she actually did, and it never comes back. The
reviews feature works out which technician a review is about by reading that
exact field, so the review now belongs to nobody.

---

## 3. A customer clicks Cancel, is refused, and sees a blank dialog

**Fixed**, in two halves.

The refusal is now visible: `runNow` closes the confirmation before reporting,
so the message lands on a card nothing is covering — *"Bookings can't be
cancelled or moved within 3 hours of the appointment"*, or *"already
cancelled"*, in both languages.

And the stale page that causes it: `/account` decided whether to show **Cancel
booking** when it rendered, and never looked again. It now re-reads on the
minute and when the tab is brought back — both only while it is actually being
looked at. `docs/MANUAL-TESTING.md` §4.6a covers the refusal.

One correction to the report: the button is hidden once the window has closed,
so *"it's 3pm, she taps Cancel"* cannot happen on a freshly loaded page. It
takes a tab left open from before the deadline — which is the half above.

**File:** `components/booking/BookingCard.tsx:364`

On failure the message is painted onto the card. The "are you sure?" dialog only
closes on success — so the message lands *behind* the dark overlay, invisible.

- Hind has a 5pm appointment. It is 3pm, and the salon's rule is no cancelling
  within three hours.
- She taps Cancel booking, then confirms.
- The server refuses.
- "You can no longer cancel this booking" is painted underneath the overlay.
- The dialog stays open and the button becomes clickable again.
- She taps again. Same nothing. She assumes the site is broken and phones the
  salon.

Guests do not hit this — their message goes into a different box that is
visible. Signed-in customers only.

---

## 4. The chatbot tells everyone the salon closes a day early

**Fixed, and it was wider than reported.** The admin closure list re-derived the
same dates by hand and got **both** ends wrong — a closure entered as 20–22
March was listed back as 19 → 21, so the round trip was visibly broken on the
screen the salon enters them on. The inverse of `addClosure`'s encoding now
exists once as `closureDays` in `lib/time.ts`, and both readers use it.
`scripts/check-fields.ts` covers it; `docs/MANUAL-TESTING.md` §5.4 and §5.4a
test both screens.

Two corrections to the report: `knowledge.ts` did **not** already import
`riyadhDateKey`, and `riyadhDateKey` alone is not the fix — `endsAt` is
exclusive, so keying it directly would report a day too many. In the reported
line the two errors cancelled on the end date, which is why only the start
looked wrong.

**File:** `lib/chat/knowledge.ts:110`

The line is `startsAt.toISOString().slice(0, 10)`.

Closures are stored in Saudi time. 20 March 00:00 Riyadh *is* 19 March 21:00
UTC. `toISOString()` converts to UTC and `slice` then chops the time off,
leaving "19 March".

- The salon sets an Eid closure, 20–22 March.
- A customer asks the assistant, "are you open on the 19th?"
- The assistant sees a closure starting "19 March" and says the salon is closed.
- She books elsewhere. The salon was open all day on the 19th.

`docs/MANUAL-TESTING.md` §5.4 will not catch this: it only checks the assistant
knows about the closure, not that it says the right dates.

**Fix:** use `riyadhDateKey()`, which the file already imports and uses
elsewhere.

---

## 5. "That code isn't right" — for a code nobody asked for

**Fixed.** `otp-required` no longer falls into the wrong-code bucket. It opens
the code dialog instead — the same one a guest gets, sending a code to the
booking's own address — so the fallback is a route she can actually finish.
Only the signed-in path can produce it: a guest always sends a code, so a
missing one means the session this page rendered with is no longer accepted.
`docs/MANUAL-TESTING.md` §4.5a covers it.

One correction to the report: customer sessions last **30 days**
(`SESSION_TTL_S`), so a login does not "quietly expire by the afternoon". The
realistic trigger is signing out in another tab, which is what §4.5a tests.

**File:** `components/booking/BookingCard.tsx:344`

`otp-required` is lumped in with `wrong`, `no-code` and `too-many-attempts` and
gets the same code-box error text. But `otp-required` does not mean "the code
was wrong", it means "you need to verify by SMS first".

- Mona opens her account page in the morning and leaves the tab open.
- By afternoon her login has quietly expired. The page still thinks she is
  signed in, because that was decided when the page loaded.
- She clicks Cancel booking.
- The server replies "you need to verify first".
- She sees "that code isn't right" — for a code she was never shown, never
  typed, and is still not offered.

The comment in that file claims a stale sign-in flag "costs a round trip, never
a wrong answer". Here it costs a wrong answer.

**Fix:** on that error, open the SMS verification dialog instead.

---

## 6. Sending a technician home leaves no record — and cannot be undone

**Fixed, in the half that is a bug.** The audit line no longer hangs off the
time-off insert. It is written whenever the floor actually moved — bookings
released, or a new time-off row — because the question the trail has to answer
is "who moved these five appointments?", and that is the release, not the row.
Still silent when nothing happened, so a second press adds no noise.
`docs/MANUAL-TESTING.md` §6.17 and §6.17a cover both.

**The "cannot be undone" half is correct behaviour, not a bug.** *Bring back*
deletes only a time-off row that is exactly today, so the front desk cannot end
someone's approved holiday — the code says so, and it is right. A technician on
leave 10–14 August should stay on leave. Her released bookings not returning is
also correct: they belong to whoever has them now, which §6.18 already asserts.

One correction to the report: the receptionist cannot see that button. The floor
screen reads `offOn()`, which covers holidays, so a technician on leave renders
with **Bring back** and no **Send home** at all. Reaching this needs a floor tab
opened before the leave was entered — the same stale-page shape as issue 3, and
the reason §6.17a says to open the tab first.

**File:** `app/(admin)/admin/(shell)/floor/actions.ts:102`

Send home does two things: take her remaining bookings back and redistribute
them, and write a line in the audit log. The first always runs. The second only
runs if there was not already a time-off record for her.

- Sara has approved holiday 10–14 August, entered last week — but bookings were
  assigned to her before that was logged.
- On 12 August the receptionist sees her on the floor screen and taps Send home.
- Her bookings are stripped and re-dealt. That part works.
- The audit log gets nothing, because a time-off record already existed.
- The manager later asks "who moved these five appointments?" and the audit page
  shows no send-home at all.
- Bring back refuses, saying she is on leave, because it only removes single-day
  time-off rows.

So the change happened, is not recorded, and cannot be reversed from the UI.

**Fix:** write the audit line whenever bookings were actually released.

---

## 7. A late customer's technician goes home and nobody notices

**Fixed.** The clock bound is gone: the release now covers her whole day, and
"not yet started" is carried entirely by the status filter, which is what it
actually means. The clause moved to `releaseToday` in `lib/assign/index.ts` so
`scripts/check-assign.ts` can run it against real rows — check 7, which fails if
the bound comes back. `docs/MANUAL-TESTING.md` §6.14a covers it by hand.

The most real of the nine: **Send home** is a live button, and a customer
running late is an ordinary Tuesday. No stale page needed.

**File:** `app/(admin)/admin/(shell)/floor/actions.ts:93`

The release only takes back bookings whose start time is still in the future.

- Reem's appointment is 2:00pm with Sara. Reem is stuck in traffic and has not
  checked in.
- At 2:20pm Sara feels ill and the desk sends her home.
- Reem's booking started at 2:00pm — in the past — so it is not taken back.
- It keeps Sara's name. Sara has left the building.
- The dealer will not touch it either, because from its point of view the
  booking already has a technician.
- Reem walks in at 2:25pm and is assigned to someone who is not there.

The comment says it releases bookings that are "not yet started" — but "not yet
started" is already covered by the status filter, which excludes `checked_in`
and `in_progress`. The extra time check is quietly doing something different,
and wrong.

---

## 8. On a phone in landscape, the guest cannot reach the Close button

**Fixed in the shell, not the three callers.** `Modal` capped every dialog at
the viewport and then left scrolling to whoever used it — and three of its four
`chrome={false}` callers forgot, which is what a default that has to be
remembered gets you. The card now scrolls itself.

The details dialog is unaffected: it pins a footer and scrolls its own middle
with `min-h-0 flex-1 overflow-y-auto`, so that region fills the card and the
outer one never has anything left to scroll. `docs/MANUAL-TESTING.md` §4.8a
covers it.

**File:** `components/booking/BookingCard.tsx:680`

Dialogs are capped at screen height, and each one is responsible for making its
own contents scrollable. The booking-details dialog does this. The guest
verification dialog and the confirm dialog do not.

- A guest checks her booking on her phone held sideways — about 400px of usable
  height.
- She types the SMS code wrong, so an error banner appears and pushes everything
  down.
- Resend code and Close are now below the bottom edge, and the dialog will not
  scroll.

Not a trap — Escape and tapping the backdrop still close it — but she has no
visible way out.

---

## 9. Two rows in the manual test sheet describe behaviour the code does not have

**Resolved by decision, not by code.** The owner's call: **the assistant may
read a booking back from its reference; it may not act on one.** Refill, cancel,
reschedule and booking are directions to the website, always.

That is what the route already does — `BOOKING_BY_REFERENCE` reads, no write
tool exists at all, and the prompt says so in both branches — so nothing in
`app/api/chat/route.ts` changed. The documents were what disagreed:

- **§5.7 and §5.8** rewritten: the assistant asks for a reference and reads the
  booking back. §5.8a checks an unknown reference gives nothing away, and §5.9a
  extends the "directions only" rule to reschedule and refill.
- **§3.15** was unrunnable — a signed-in customer is redirected off
  `/my-bookings`. Rewritten as the boundary that actually exists: signed out,
  someone else's reference *is* readable, and cancelling it still demands a code
  sent to that booking's own address.

**Still outstanding:** the PR description says *"Guests get no booking tool at
all"*, which was true of an earlier draft and is not true of this one. It needs
the same correction; nothing in the repo can fix it.

**File:** `docs/MANUAL-TESTING.md:187` and `:136`

**§5.8** tells the tester that a signed-out visitor saying "my reference is
RON-4F2K, when is it?" must not get the booking read out. The code does the
opposite on purpose: `app/api/chat/route.ts` has a `BOOKING_BY_REFERENCE` tool
for exactly this, and the assistant's instructions say to ask for the reference
and then use it. A tester following the sheet will report a bug that is not one,
and someone will spend a day fixing working code.

**§3.15** says to sign in as customer A and then look up customer B's reference
at `/my-bookings`. That cannot be done — any signed-in customer is redirected
straight to `/account`. It is the one test aimed at "can I see someone else's
booking?", and it is impossible to run.
