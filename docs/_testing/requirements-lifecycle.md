# Requirement register — `lifecycle`

Phase 1 of `nextjs-drizzle-hardening`. What happens to a booking after it exists,
and the customer's self-service surface.

Sources are cited `file:line`. Per the coordinator's correction of 2026-09-02,
**source comments are first-class specification**: this codebase documents dated
decisions, deliberate constraints and known traps inline, and a rule asserted only
in a comment is still a rule. Rows whose only source is a comment are marked
`(code)`; rows from `docs/` are marked `(docs)`. Where the two disagree the row is
`CONTRADICTION` and is *not* tested as spec — see
`docs/_testing/known-bugs-lifecycle.md`.

`<ENT>` codes from `docs/_testing/glossary.md`: `BKG` bookings, `TIC`
ticket_counters, `OTP` otps, `STA` stations, `SVC` services.

`actions.ts` below is `app/(admin)/admin/(shell)/bookings/actions.ts`, the single
write path for `booking_status`.

---

## 1. `booking_status` — the lifecycle itself (Phase 5 item 15)

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-BKG-001 | (docs) glossary.md:L92 | `pending → confirmed → checked_in → in_progress → completed`, with `cancelled` and `no_show` as exits | state | P0 |
| REQ-BKG-002 | (code) lib/db/schema.ts:L51-62 | `booking_status` has exactly seven values, in that order | state | P0 |
| REQ-BKG-003 | (code) lib/db/schema.ts:L54-56 | `checked_in` = customer is here and handed to a technician, who has not started. The gap to `in_progress` is the salon's waiting time | state | P1 |
| REQ-BKG-004 | (code) lib/db/schema.ts:L399-402 | `finished_at` is the technician saying she is done, which is **not** the ticket being closed; the status only reaches `completed` when the receptionist does that | state | P0 |
| REQ-BKG-005 | (code) actions.ts:L48-50 | `checked_in` and `completed` need only `bookings.manage`; **every other** status needs `bookings.status` | authz | P0 |
| REQ-BKG-006 | (code) actions.ts:L51 | A status outside the seven is refused `invalid-status` | validation | P0 |
| REQ-BKG-007 | (code) actions.ts:L53-54 | An unknown booking id is refused `not-found` | state | P0 |
| REQ-BKG-008 | (code) actions.ts:L56-60 | Entering a status stamps its moment, guarded on the *transition*, so re-saving the same status does not reset a clock commission is read from | side-effect | P0 |
| REQ-BKG-009 | (code) actions.ts:L71-76 | `→ checked_in` earlier than `checkin_early_min` before the slot is refused `too-early` | validation | P0 |
| REQ-BKG-010 | (code) actions.ts:L81-84 | `→ checked_in` picks a technician **only** when the row does not already name one | side-effect | P1 |
| REQ-BKG-011 | (code) actions.ts:L91-94 | `→ checked_in` stamps `checked_in_at` **and** `tech_notified_at` | side-effect | P1 |
| REQ-BKG-012 | (code) actions.ts:L95 | `→ in_progress` stamps `started_at` | side-effect | P0 |
| REQ-BKG-013 | (code) actions.ts:L86-99 | `setBookingStatus` **never** stamps `finished_at` | side-effect | P0 |
| REQ-BKG-014 | (code) actions.ts:L96 | `cancel_reason` is written only when the destination is `cancelled`, otherwise preserved | side-effect | P1 |
| REQ-BKG-015 | (code) actions.ts:L101-106 | Every status write records an audit row; `action` is `cancel` for `→ cancelled`, `update` otherwise | side-effect | P0 |
| REQ-BKG-016 | (code) actions.ts:L123-125 | `→ completed` invites a review, guarded on the transition, and one invitation per booking is a database constraint | side-effect | P1 |
| REQ-BKG-017 | (code) front-desk/actions.ts:L127-130 | The front desk may only check in a booking currently `confirmed`; `checked_in`/`in_progress` are `already`, everything else `not-checkable` | state | P0 |
| REQ-BKG-018 | (code) actions.ts:L175-177 | Staff reschedule refuses anything not `pending` or `confirmed`, with `not-movable` | state | P0 |
| REQ-BKG-019 | (code) actions.ts:L330-355 | `rescheduleNoShow` moves a `no_show` back to `confirmed` and clears `no_show_at`, so it can be missed again | state | P1 |
| REQ-BKG-020 | (docs) NO-SHOW-RELEASE.md:L26-33 | `sweepNoShows` moves `confirmed` → `no_show` only for today, past `no_show_grace_min`, and only where `no_show_at is null` | state | P0 |
| REQ-BKG-021 | (docs) NO-SHOW-RELEASE.md:L43 | `in_progress` and `completed` mean the customer arrived and are never released | state | P0 |
| **REQ-BKG-022** | **CONTRADICTION** | glossary.md:L92 and NO-SHOW-RELEASE.md name a legal transition set; `setBookingStatus` enforces **no transition table at all** — any of the seven is reachable from any of the seven. See BUG-LIFECYCLE-001 | state | P0 |
| **REQ-BKG-023** | **CONTRADICTION** | `resolveNoShow` docstring (actions.ts:L228-230) says "the status is already `no_show`" and "Touches nothing else", but the statement below it writes `status: "cancelled"` (actions.ts:L245). docs/NO-SHOW-RELEASE.md:L111-121 lists only the three no-show columns. See BUG-LIFECYCLE-002 | state | P0 |
| **REQ-BKG-024** | **CONTRADICTION** | docs/ADMIN-PANEL.md:L141 enumerates `pending \| confirmed \| in_progress \| completed` — omitting `checked_in`, `cancelled`, `no_show`. See BUG-LIFECYCLE-003 | state | P2 |

## 2. Cancellation window — `lib/cancellation.ts`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-BKG-030 | (code) lib/cancellation.ts:L29 | Only `pending` and `confirmed` are open to the customer | state | P0 |
| REQ-BKG-031 | (code) lib/cancellation.ts:L21-23 | `pending` is included on purpose: an explicit cancel must not wait out `booking_hold_min` | state | P1 |
| REQ-BKG-032 | (code) lib/cancellation.ts:L39-41 | `cancelDeadline` = `startsAt − cutoffHours`, exported so the gate and the countdown cannot disagree | validation | P0 |
| REQ-BKG-033 | (code) lib/cancellation.ts:L63 | `cancelled` and `no_show` refuse as `already-cancelled` | state | P0 |
| REQ-BKG-034 | (code) lib/cancellation.ts:L64 | `checked_in`, `in_progress`, `completed` refuse as `not-cancellable` | state | P0 |
| REQ-BKG-035 | (code) lib/cancellation.ts:L65-67 | Standing **exactly** on the deadline is too late — the comparison is `>=`, so a booking is never both cancellable and not in the same millisecond | validation | P0 |
| REQ-BKG-036 | (code) lib/cancellation.ts:L77-78 | `canCancel` is exactly `cancelRefusal(...) === null` — one rule, both actions | validation | P0 |
| REQ-BKG-037 | (docs) CANCEL-RESCHEDULE-ADDON.md:L29 | `cancel_cutoff_hours` defaults to 3 | validation | P1 |
| REQ-BKG-038 | (docs) CANCEL-RESCHEDULE-ADDON.md:L125-127 | The three refusals are reported separately so the message is never a lie | validation | P0 |

## 3. `POST /api/my-bookings/cancel`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-BKG-040 | (code) cancel/route.ts:L44-46 | Throttled to 5/min per IP, keyed `cancel:<ip>` | side-effect | P0 |
| REQ-BKG-041 | (code) cancel/route.ts:L48-52 | Malformed JSON → `400 invalid-json` | validation | P1 |
| REQ-BKG-042 | (code) cancel/route.ts:L32-39 | `code` 4–20 chars; `otp` optional, exactly `OTP_LENGTH` digits | validation | P0 |
| REQ-BKG-043 | (code) cancel/route.ts:L58 | The code is upper-cased before lookup | validation | P2 |
| REQ-BKG-044 | (code) cancel/route.ts:L64 | An unknown reference is refused `401 wrong` | authz | P0 |
| REQ-BKG-045 | (code) cancel/route.ts:L66-69 | The action is gated by `refuseBookingAction`, not the reference | authz | P0 |
| REQ-BKG-046 | (code) cancel/route.ts:L73-84 | A refusal is `409` carrying `error`, `cancelBy` and `cutoffHours` | contract | P0 |
| REQ-BKG-047 | (docs) CANCEL-RESCHEDULE-ADDON.md:L157-167 | A group cancels as a unit; either member's reference cancels both | state | P0 |
| REQ-BKG-048 | (code) cancel/route.ts:L97-114 | One UPDATE, guarded on status as well as id, so two taps cannot produce two refunds | side-effect | P0 |
| REQ-BKG-049 | (code) cancel/route.ts:L116-118 | Nothing updated → `409 already-cancelled` | state | P0 |
| REQ-BKG-050 | (code) cancel/route.ts:L120-123 | Money moves **after** the chair is released, and never throws | side-effect | P0 |
| REQ-BKG-051 | (docs) CANCEL-RESCHEDULE-ADDON.md:L144-155 | A failed refund still returns `200` with `refunded: false`; the chair is released regardless | side-effect | P0 |
| REQ-BKG-052 | (code) cancel/route.ts:L125-136 | An audit row is written with `actor_name = customer`, `actor_id = null` | side-effect | P0 |
| REQ-BKG-053 | (code) cancel/route.ts:L143 | `assignIfToday` re-deals the day after a cancellation | side-effect | P1 |
| REQ-BKG-054 | (docs) CANCEL-RESCHEDULE-ADDON.md:L142 | Cancelling an unpaid `pending` hold → `200`, `refunded: false` | state | P1 |
| **REQ-BKG-055** | **CONTRADICTION** | CANCEL-RESCHEDULE-ADDON.md:L137 says a made-up reference gets `404 not-found`; the route returns `401 wrong`. See BUG-LIFECYCLE-004 | contract | P1 |
| **REQ-BKG-056** | **CONTRADICTION** | CANCEL-RESCHEDULE-ADDON.md:L270-274 "What is deliberately not here — **No OTP on cancel or reschedule**"; both routes now require one. See BUG-LIFECYCLE-005 | authz | P0 |

## 4. `POST /api/my-bookings/reschedule`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-BKG-060 | (code) reschedule/route.ts:L39-41 | Throttled to 5/min per IP, keyed `reschedule:<ip>` | side-effect | P0 |
| REQ-BKG-061 | (code) reschedule/route.ts:L28-36 | `startsAt` must be an ISO datetime | validation | P0 |
| REQ-BKG-062 | (code) reschedule/route.ts:L70-83 | The window is checked against the appointment they **have**, not the one they want | state | P0 |
| REQ-BKG-063 | (code) reschedule/route.ts:L85-90 | The destination must clear `booking_lead_time_min`, else `409 too-soon` with `leadTimeMin` | validation | P0 |
| REQ-BKG-064 | (docs) CANCEL-RESCHEDULE-ADDON.md:L139 | A taken slot → `409 slot-taken`, original unchanged | state | P0 |
| REQ-BKG-065 | (code) reschedule/route.ts:L1-6 | Nothing moves financially — same service, duration, total; no charge, no refund, no new ticket number | side-effect | P0 |
| REQ-BKG-066 | (code) reschedule/route.ts:L8-10 | The chair is re-picked by the engine, not kept | side-effect | P1 |
| REQ-BKG-067 | (code) lib/bookings.ts:L998-1001 | Each guest keeps their own duration across a move | validation | P0 |
| REQ-BKG-068 | (code) lib/bookings.ts:L1023-1031 | `technician_id` is emptied inside the same transaction, then re-dealt by `assignIfToday` | side-effect | P0 |
| REQ-BKG-069 | (code) reschedule/route.ts:L114-117 | The new chair is deliberately **not** reported | contract | P2 |
| REQ-BKG-070 | (code) lib/auth/rbac.ts:L87-97 | `admin` has **no** `bookings.reschedule` — granted 2026-08-28, taken back 2026-09-01 | authz | P0 |
| REQ-BKG-071 | (code) lib/auth/rbac.ts:L123-128 | `receptionist` **keeps** `bookings.reschedule`; the counter alternative loses the ticket number | authz | P0 |
| **REQ-BKG-072** | **CONTRADICTION** | actions.ts:L147-149 says "The salon has since granted it to admin as well (see lib/auth/rbac.ts)"; rbac.ts:L87-97 says the opposite in the same repo. See BUG-LIFECYCLE-006 | authz | P0 |

## 5. Refill window — `lib/refill.ts` and `POST /api/my-bookings/refill`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-SVC-080 | (docs) REFILL-AND-GIFT-CARDS.md:L49 | Eligible only when `refill_days > 0`; `0` means the service has no refill | state | P0 |
| REQ-SVC-081 | (docs) REFILL-AND-GIFT-CARDS.md:L50-51 | The appointment must have happened — `completed`, or `confirmed` with a start time in the past | state | P0 |
| REQ-SVC-082 | (docs) REFILL-AND-GIFT-CARDS.md:L52 | No refill already claimed against it | state | P0 |
| REQ-SVC-083 | (docs) REFILL-AND-GIFT-CARDS.md:L53-55 | A refill does not earn another refill | state | P0 |
| REQ-SVC-084 | (docs) REFILL-AND-GIFT-CARDS.md:L56 | `now <= startsAt + refill_days` | validation | P0 |
| REQ-SVC-085 | (code) lib/refill.ts:L69-73 | The last partial day still counts — `Math.ceil`, so it reads "1 day left" rather than 0 | validation | P0 |
| REQ-SVC-086 | (code) lib/refill.ts:L46-50 | **Zero days left means no offer** — there is no separate eligibility flag | contract | P0 |
| REQ-SVC-087 | (code) lib/refill.ts:L30-40 | The deadline is the service's and nobody's to move; it is not overridable per booking | validation | P1 |
| REQ-SVC-088 | (code) lib/refill.ts:L77-80 | `refillPriceHalalas` clamps the percentage to 0–100 and rounds to whole halalas | money | P0 |
| REQ-SVC-089 | (code) lib/bookings.ts:L335-349 | A window is only *claimed* by a refill that is not `cancelled` or `no_show` — a cancelled refill hands the window back | state | P0 |
| REQ-SVC-090 | (code) refill/route.ts:L43-45 | Throttled to 10/min per IP, keyed `refill:<ip>` | side-effect | P0 |
| REQ-SVC-091 | (code) refill/route.ts:L76-79 | Same credential as cancel and reschedule | authz | P0 |
| REQ-SVC-092 | (code) refill/route.ts:L92-96 | `expiresAt` comes from `refillWindowEnd`, never hand-computed | contract | P0 |
| REQ-SVC-093 | (code) refill/route.ts:L105 | `bookUrl` is null exactly when `daysLeft` is 0 | contract | P1 |
| REQ-SVC-094 | (code) refill/route.ts:L74 | An unknown reference is refused `401 wrong` | authz | P0 |

## 6. Booking-action auth — `lib/booking-auth.ts`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-BKG-100 | (code) lib/booking-auth.ts:L12-15 | A signed-in customer passes **only if the booking is theirs** — without the equality any signed-in customer could act on any booking whose reference they knew | authz | P0 |
| REQ-BKG-101 | (code) lib/booking-auth.ts:L17-19 | Anyone else needs a code emailed to the booking's own address; a forwarded confirmation must not carry the power to cancel | authz | P0 |
| REQ-BKG-102 | (code) lib/booking-auth.ts:L54 | No OTP on the first attempt → `401 otp-required`, which is the screen's cue | contract | P1 |
| REQ-BKG-103 | (code) lib/booking-auth.ts:L59-62 | `too-many-attempts` is `429`; `wrong` and `no-code` are `401` | contract | P0 |
| REQ-BKG-104 | (code) lib/booking-auth.ts:L21-23 | A group shares one `customerId`, so ownership of the anchor is ownership of the group | authz | P1 |
| REQ-BKG-105 | (code) lib/booking-auth.ts:L42-45 | These routes need not disguise an unknown reference — the read endpoint answers that openly | contract | P2 |
| REQ-OTP-106 | (code) lib/otp.ts:L86-104 | Issuing a code burns every outstanding one for that subject | side-effect | P0 |
| REQ-OTP-107 | (code) lib/otp.ts:L124-155 | Single use, 10-minute TTL, 5 attempts, then burned | authz | P0 |
| REQ-OTP-108 | (code) lib/otp.ts:L40-50 | The subject is built by `bookingSubject`, never assembled by a caller | validation | P1 |
| REQ-BKG-109 | (code) lib/account/guard.ts:L39-41 | A deleted, blocked, or never-verified customer is signed out immediately | authz | P0 |
| REQ-BKG-110 | (code) lib/account/session.ts:L9-17 | The customer token and the staff token are separated by SALT — a staff token fails to *decrypt* here | authz | P0 |

## 7. `POST /api/my-bookings` and `POST /api/my-bookings/otp`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-BKG-120 | (docs) REFILL-AND-GIFT-CARDS.md:L74-75 | The lookup returns no name, phone or email | contract | P0 |
| REQ-BKG-121 | (docs) REFILL-AND-GIFT-CARDS.md:L75 | Unknown references return `404`; throttled 10/min per IP | contract | P0 |
| REQ-BKG-122 | (code) my-bookings/route.ts:L14-18 | A reference opens **that** booking and nothing else — it used to return the customer's whole history | authz | P0 |
| REQ-BKG-123 | (code) lib/bookings.ts:L367-375 | A reference opens the whole *party* — both group members, since they share one `customer_id` | authz | P0 |
| REQ-BKG-124 | (code) lib/bookings.ts:L420-422 | The reference path is capped at 10 rows, the session path at 50 | contract | P2 |
| REQ-OTP-125 | (code) otp/route.ts:L8-11 | The response never says whether the reference exists | authz | P0 |
| REQ-OTP-126 | (code) otp/route.ts:L25-28 | Two throttles: 6/min per IP, and one email per booking per minute | side-effect | P0 |
| REQ-OTP-127 | (code) otp/route.ts:L81-86 | A booking inside its cooldown answers `sent: true, throttled: true` with a masked address | contract | P1 |
| REQ-OTP-128 | (code) otp/route.ts:L98-103 | A mail failure surfaces as `502 mail-failed`, unlike an invoice | contract | P1 |
| REQ-OTP-129 | (code) lib/otp.ts:L158-162 | `maskEmail` reveals one character of the local part and the whole domain | contract | P2 |

## 8. Ticket numbering — `lib/tickets.ts`, `ticket_counters`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-TIC-140 | (code) lib/tickets.ts:L11 | `1 → "A1"`, `99 → "A99"`, `100 → "B1"` | validation | P0 |
| REQ-TIC-141 | (code) lib/tickets.ts:L7-9 | No letter is skipped — a ticket is read off a screen, not dictated | validation | P2 |
| REQ-TIC-142 | (code) lib/tickets.ts:L16-17 | Known ceiling: wraps back to `A1` after 2574 in one day at one branch | validation | P2 |
| REQ-TIC-143 | (code) lib/bookings.ts:L505-509 | The upsert takes a row lock, so two transactions at the same instant get different numbers | side-effect | P0 |
| REQ-TIC-144 | (code) lib/bookings.ts:L505-509 | Asking for 2 at once is what gives a group its consecutive pair | side-effect | P0 |
| REQ-TIC-145 | (code) lib/db/schema.ts:L553-564 | The counter is keyed `(branch_id, day)` — per branch, per day | state | P0 |
| REQ-TIC-146 | (code) lib/db/schema.ts:L549-551 | The day is the day of the **appointment**, not of payment | state | P0 |
| REQ-TIC-147 | (code) lib/db/schema.ts:L418-422 | `ticket_no` is null until the booking is confirmed — an unpaid hold gets no number | state | P1 |

## 9. Floor colour and the desk clock

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-BKG-160 | (code) lib/booking-pulse.ts:L5-8 | "Over" is `finished_at`, not `completed` | contract | P0 |
| REQ-BKG-161 | (code) lib/booking-pulse.ts:L32-34 | `checked_in` is the waiting colour, and outranks a stale `finished_at` | contract | P1 |
| REQ-BKG-162 | (code) lib/booking-pulse.ts:L26-29 | States with no light of their own return `""` so callers keep their own styling | contract | P1 |
| REQ-BKG-163 | (code) lib/booking-pulse.ts:L33,L37 | Every moving state carries a `motion-reduce:` twin that keeps both the colour and the border | a11y | P0 |
| REQ-BKG-164 | (code) lib/booking-clock.ts:L1-10 | The desk clock is check-in → finish, the *visit*; `started_at → finished_at` is the technician's work | contract | P0 |
| REQ-BKG-165 | (code) lib/booking-clock.ts:L9-11 | Falls back to `started_at` for a walk-in pushed straight to `in_progress` | contract | P1 |
| REQ-BKG-166 | (code) lib/booking-clock.ts:L11-12 | Exactly one of `runningMs`/`tookMs` is ever non-null | contract | P0 |
| REQ-BKG-167 | (code) lib/booking-clock.ts:L13-20 | A booking in a terminal state is over whatever the timestamps say; with no finish time it shows nothing rather than a growing figure | contract | P0 |
| REQ-BKG-168 | (code) lib/booking-clock.ts:L41,L46 | Durations are clamped at zero, so clock skew never prints a negative | validation | P1 |

Rows 160–168 are largely **already covered** by `scripts/check-pulse.ts`. Per the
task brief, `tests/lifecycle/pulse-clock.test.ts` does not duplicate it and
extends only where it stops: the reduced-motion twins beyond the two moving
states, and clock arithmetic across midnight and a day boundary.

## 10. The station QR chain

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-STA-180 | (code) lib/db/schema.ts:L195-203 | The sticker encodes a random `qr_token`, **not** the row id, so a token cannot be used to address the station anywhere else | authz | P0 |
| REQ-STA-181 | (code) lib/db/schema.ts:L206 | `qr_token` is unique | state | P0 |
| REQ-STA-182 | (code) lib/db/schema.ts:L203 | `qr_token` is `not null` with a random default, so no chair can exist without one | state | P0 |
| REQ-STA-183 | (docs) CANCEL-RESCHEDULE-ADDON.md:L243 | `/station/not-a-uuid` → `404`, rejected before the query | validation | P0 |
| REQ-STA-184 | (docs) CANCEL-RESCHEDULE-ADDON.md:L244-245 | A random uuid, or a retired chair's token → `404` | authz | P0 |
| REQ-STA-185 | (docs) CANCEL-RESCHEDULE-ADDON.md:L247 | `POST /api/bookings` with a token from a **different** branch → `404 unknown-station` | authz | P0 |
| REQ-STA-186 | (docs) CANCEL-RESCHEDULE-ADDON.md:L248 | A raw `stationId` is ignored — the field does not exist in the request schema, so nobody can deny a chair by pinning it | authz | P0 |
| REQ-STA-187 | (code) app/api/bookings/route.ts:L114-117 | An unknown or retired token is never a reason to silently fall back to another chair | side-effect | P0 |
| REQ-STA-188 | (docs) CANCEL-RESCHEDULE-ADDON.md:L19-23 | The migration adds the column `not null` + `unique` in one statement, so it could not have succeeded with blank or shared tokens | state | P1 |
