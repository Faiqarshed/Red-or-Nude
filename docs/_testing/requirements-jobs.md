# Requirements register — `jobs`

Phase 1 of `nextjs-drizzle-hardening`, as amended by the coordinator: **the
source is a first-class specification.** In this area the code comments carry
rules that appear nowhere in `docs/` — the whole dedupe contract for the
quarter-hourly reminder lives in a comment on `bookings.tech_notified_at` and in
the route header, and the reason `reviews_booking_unique` exists at all is a
comment on the constraint. Those rows are cited to `file:line` exactly like a
docs line, and the `Source` column says which kind it is.

Area = scheduled work, assignment, and everything that sends a message:
the four `/api/cron/*` routes, `lib/assign/`, `lib/notify/`, `lib/email/`,
`lib/reviews/`, `POST /api/reviews`, `/review/[token]`.

`<ENT>` codes from `docs/_testing/glossary.md`. `JOB` is this area's own code for
a cron surface, which is not an entity and has no table.

---

## Cron transport — all four routes

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-JOB-001 | code `app/api/cron/assign-day/route.ts:32-33` | "A cron endpoint is a public URL. Without this, anyone could reshuffle the salon's floor from the outside." | authz | P0 |
| REQ-JOB-002 | code `app/api/cron/assign-day/route.ts:34-37` | A request whose `authorization` header is not exactly `Bearer ${CRON_SECRET}` is rejected `401 {error:"unauthorized"}` | authz | P0 |
| REQ-JOB-003 | code `app/api/cron/assign-day/route.ts:35` | When `CRON_SECRET` is unset or empty every request is rejected, including a correct-looking one | authz | P0 |
| REQ-JOB-004 | docs/DAY-START-ASSIGNMENT.md:L305 | "Without the header → `401`." | authz | P0 |
| REQ-JOB-005 | docs/DAY-START-ASSIGNMENT.md:L215 | "A `CRON_SECRET` in `.env.local` is what the two cron endpoints check for; without one they refuse every request, including yours." | authz | P0 |
| REQ-JOB-006 | code `app/api/cron/refill-reminders/route.ts:26-27` | "A cron endpoint is a public URL; without this anyone could make the salon message its whole customer list." | authz | P0 |
| REQ-JOB-007 | code `app/api/cron/staff-codes/route.ts:19-20` | "A cron endpoint is a public URL. Without this, anyone could mint the salon's 90%-off codes on demand." | authz | P0 |
| REQ-JOB-008 | code `app/api/cron/tech-reminders/route.ts:37-38` | "A cron endpoint is a public URL; without this anyone could mail the salon's staff on demand." | authz | P0 |
| REQ-JOB-009 | code `app/api/cron/*/route.ts` (`dynamic = "force-dynamic"`) | No cron response is statically cached | side-effect | P1 |
| REQ-JOB-010 | glossary "External dependencies" | Cron caller is a shared-secret header; the unauthenticated path is in scope | authz | P0 |
| REQ-JOB-011 | *(security case, no REQ in docs — gap G2)* | The `x-middleware-subrequest` bypass header (CVE-2025-29927) must not reach a cron body | authz | P0 |
| REQ-JOB-012 | code `middleware.ts:1-3` | "middleware is not a security boundary" — every cron route re-checks the secret itself | authz | P0 |

## `GET /api/cron/assign-day`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-JOB-020 | code `app/api/cron/assign-day/route.ts:14-16` | "Safe to run more than once, and safe to run late: assignDay only fills rows where technician_id is null, so a retry, a double fire, or a mid-morning run assigns nothing twice and overwrites nobody's decision." | side-effect | P0 |
| REQ-JOB-021 | code `app/api/cron/assign-day/route.ts:39-43` | Only `branches.active = true`, in `branches.sort` order | state | P1 |
| REQ-JOB-022 | code `app/api/cron/assign-day/route.ts:48-50` | "Branch by branch rather than all at once… one branch's empty floor must not stall another's." | side-effect | P1 |
| REQ-JOB-023 | code `app/api/cron/assign-day/route.ts:52-63` | `sweepNoShows(branch)` runs **before** `assignDay(branch)` — "Close yesterday before opening today." | side-effect | P0 |
| REQ-JOB-024 | code `app/api/cron/assign-day/route.ts:59-62` | "At 07:00 Riyadh the only bookings past their grace period are yesterday's, so this cannot touch the day assignDay is about to deal out." | state | P1 |
| REQ-JOB-025 | code `app/api/cron/assign-day/route.ts:70` | Response is `{ok:true, branches, assigned, unassigned}`, summed across branches | validation | P1 |
| REQ-JOB-026 | docs/DAY-START-ASSIGNMENT.md:L303 | "`{ ok: true, branches: n, assigned: 6, unassigned: 0 }` — or an honest smaller count if the slots genuinely cannot all fit." | validation | P1 |
| REQ-JOB-027 | docs/DAY-START-ASSIGNMENT.md:L304 | "Run it a **second time** → `assigned: 0`. Idempotent." | side-effect | P0 |
| REQ-JOB-028 | docs/DAY-START-ASSIGNMENT.md:L363-365 | "Two runs at once… Nobody is double-assigned" | side-effect | P0 |
| REQ-JOB-029 | docs/DAY-START-ASSIGNMENT.md:L358-360 | "Every technician off today. The run assigns nothing and returns cleanly." | state | P1 |
| REQ-JOB-030 | docs/DAY-START-ASSIGNMENT.md:L376 | "A pending (unpaid) booking. Never assigned" | state | P0 |

## `GET /api/cron/tech-reminders`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-BKG-040 | code `lib/db/schema.ts:416` + route `:17-20` | "Sent once, ever: `tech_notified_at` is stamped after the mail, and check-in stamps it too, so a customer who arrives early never costs her technician a second copy of the same message." | side-effect | P0 |
| REQ-BKG-041 | code `app/api/cron/tech-reminders/route.ts:58-61` | "Stamped first. notifyTechnician never throws, so a failure there is a missing nudge — while a failure *after* an unstamped send would mail the same technician again every quarter hour" | side-effect | P0 |
| REQ-BKG-042 | code `app/api/cron/tech-reminders/route.ts:45-56` | Due = `status='confirmed'` AND `technician_id is not null` AND `tech_notified_at is null` AND `now <= starts_at <= now + assign_notify_min` | state | P0 |
| REQ-BKG-043 | code `app/api/cron/tech-reminders/route.ts:50-52` | "Not the ones already past: a slot that started before this run went by unassigned or unnoticed, and a late 'starting soon' helps nobody." | state | P1 |
| REQ-BKG-044 | code `app/api/cron/tech-reminders/route.ts:14-15` | "The window (`assign_notify_min`) must stay comfortably wider than the gap between runs, or an appointment can fall between two firings and be missed." | state | P1 |
| REQ-BKG-045 | code `lib/settings.ts` `assign_notify_min` | Default window is 30 minutes | validation | P2 |
| REQ-BKG-046 | docs/DAY-START-ASSIGNMENT.md:L336-338 | "One mail… Run again → `sent: 0`… Now check that customer in → **no second mail**." | side-effect | P0 |
| REQ-BKG-047 | code `app/(admin)/admin/(shell)/bookings/actions.ts:94` | Check-in (`entering("checked_in")`) stamps `tech_notified_at`, otherwise carries the existing stamp forward | side-effect | P0 |
| REQ-BKG-048 | code route `:70` | Response is `{ok:true, sent}` where `sent` = rows stamped | validation | P2 |

## `GET /api/cron/staff-codes`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-PRM-060 | code `app/api/cron/staff-codes/route.ts:6-9` | "Safe to run more than once: issueMonthlyCode skips anyone who already has a code inside the window… It is also safe to run late — the code is dated to the month it is issued in, not to the moment the job ran." | side-effect | P0 |
| REQ-PRM-061 | code `lib/staff-codes.ts:24-29` | `monthWindow(date)` = first day of that **UTC** month (inclusive) to first day of the next (exclusive) | validation | P1 |
| REQ-PRM-062 | code `lib/staff-codes.ts:60-64` | "Idempotent by design: a member who already has a code inside that window gets nothing new." | side-effect | P0 |
| REQ-PRM-063 | code `lib/staff-codes.ts:96-107` | The issued code is `percent`, value `STAFF_CODE_PERCENT` (90), `max_uses` 1, `starts_at`/`ends_at` = the month window, active | validation | P0 |
| REQ-PRM-064 | code `lib/staff-codes.ts:32-36` | `"SARA", "SARA2", …` — bounded at ten tries, then `no-free-code` | validation | P1 |
| REQ-PRM-065 | code `lib/staff-codes.ts:93` | First name only | validation | P2 |
| REQ-PRM-066 | code `lib/staff-codes.ts:112-114` | "Nothing deletes last month's — an unused code simply lapses when its window closes" | side-effect | P1 |
| REQ-PRM-067 | code `lib/staff-codes.ts:117` | Only `staff.active = true` get a code | state | P1 |
| REQ-PRM-068 | code `lib/staff-codes.ts:75` | An unknown staff id returns `not-found`, writes nothing | state | P1 |

## `GET /api/cron/refill-reminders`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-BKG-080 | code `app/api/cron/refill-reminders/route.ts:4-8` | "Nothing schedules this yet — it sends through the notify seam, which is a log driver until a real provider is configured" | side-effect | P2 |
| REQ-BKG-081 | code route `:53-59` | Scanned cohort = `status in ('completed','confirmed')` AND `oldest <= starts_at < now`, `oldest` = now − 365 days | state | P1 |
| REQ-BKG-082 | code route `:88-92` | "Exactly the cohort whose window closes on the reminder day… The `!daysLeft` guard matters: 0 means no refill is on offer, so a reminder_days of 0 must not match everything." | validation | P0 |
| REQ-BKG-083 | code route `:104-127` | Email when `customers.email`, WhatsApp when `customers.phone`; both count toward `sent` | side-effect | P1 |
| REQ-BKG-084 | code route `:109`,`:118` | Language is `customers.lang`, defaulting to `ar` | validation | P0 |
| REQ-BKG-085 | code route `:129` | Response is `{scanned, sent}` — note **no `ok`**, unlike every other cron in this area | validation | P2 |
| REQ-BKG-086 | code route `:93-94` (`ponytail:`) | "a missed run means that day's cohort gets no reminder at all. Add a `reminder_sent_at` column and a range check if that ever matters." | side-effect | P1 |
| REQ-BKG-087 | code `lib/refill.ts:51-75` | `refillDaysLeft` is 0 for an already-refilled booking, a refill of its own, a service with `refill_days = 0`, an unserved booking, or an expired window; otherwise whole days **rounded up** | validation | P0 |

## `lib/assign/` — the decision

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-STF-100 | docs/DAY-START-ASSIGNMENT.md:L57-63 | `chooseTechnician`: stable id order; unavailable dropped; fewest bookings today wins; ties keep order; nobody left → `null` | validation | P0 |
| REQ-STF-101 | code `lib/assign/index.ts:66-73` | "Returns null when everyone is busy — check-in still succeeds, unassigned… Refusing to check a customer in because the floor is full would be worse than the problem it solves." | state | P0 |
| REQ-STF-102 | code `lib/assign/index.ts:41-50` | `offOn` compares against the **Riyadh** calendar day as a string, ranges inclusive at both ends | validation | P0 |
| REQ-STF-103 | code `lib/assign/index.ts:52` | `offOn(day, conn)` — `conn` lets a run read time off on its own transaction | validation | P2 |
| REQ-STF-104 | code `lib/assign/index.ts:86-88` | Candidates are `active` AND `role='technician'` AND `branch_id = this branch`, ordered by id | authz | P0 |
| REQ-STF-105 | code `lib/assign/index.ts:94-97` | The busy query is "deliberately not bounded to today or to this branch: a technician holding a customer is busy whenever and wherever that booking started" | state | P1 |
| REQ-STF-106 | code `lib/assign/index.ts:33` | Busy = `checked_in` or `in_progress` | state | P1 |
| REQ-STF-107 | docs/DAY-START-ASSIGNMENT.md:L66-69 | `planAssignments`: one pass in start order; unavailable also means already holding an overlapping slot; half-open intervals, so 10–11 and 11–12 stack | validation | P0 |
| REQ-STF-108 | code `lib/assign/index.ts:168-172` (`ponytail:`) | "greedy first-fit, one pass, no backtracking. A later booking can come back null where reshuffling earlier ones would have fitted it." | validation | P1 |
| REQ-STF-109 | code `lib/assign/index.ts:181-183` | "Both cloned, so a caller's maps are not mutated under it." | side-effect | P1 |
| REQ-STF-110 | code `lib/assign/index.ts:161-163` | "`initialLoad` is how bookings already assigned by hand pull their weight" | validation | P1 |
| REQ-BKG-111 | code `lib/assign/index.ts:217-221` | "**It only ever fills empty rows.** … That is what makes it safe to re-run, safe to double-fire, and safe to run late." | side-effect | P0 |
| REQ-BKG-112 | code `lib/assign/index.ts:223-225` | "Confirmed bookings only: a `pending` row is an unpaid hold" | state | P0 |
| REQ-BKG-113 | code `lib/assign/index.ts:262-277` | `lockBranch` — one run per branch at a time, `pg_advisory_xact_lock(hashtext(branch))`, released by the commit | side-effect | P0 |
| REQ-BKG-114 | code `lib/assign/index.ts:302-309` | "Cancelled and no-show rows are not 'spoken for': the technician named on one is standing free." | state | P0 |
| REQ-BKG-115 | code `lib/assign/index.ts:338-340` | "`isNull` again, not just in the read: a receptionist can name someone between the read above and this write, and hers wins." | side-effect | P0 |
| REQ-AUD-116 | code `lib/assign/index.ts:243-252` | Every automatic assignment writes an `assign-technician` audit row under actor `{id:null, name:"Automatic assignment"}`, **after** the commit | side-effect | P1 |
| REQ-BKG-117 | code `lib/assign/index.ts:360-374` | `releaseToday` empties **her whole day**, not the rest of it — `confirmed` only, `checked_in`/`in_progress` stay hers | state | P0 |
| REQ-BKG-118 | docs/LIVE-ASSIGNMENT.md:L176-182 | "a customer stuck in traffic has a start time in the past and no check-in, so a `startsAt >= now` bound skips exactly him" | state | P0 |
| REQ-BKG-119 | code `lib/assign/index.ts:390-393` | `isToday` compares Riyadh calendar days | validation | P0 |
| REQ-BKG-120 | code `lib/assign/index.ts:415-421` | `assignIfToday` — today only, and "Never throws. A booking without a technician is a line on the front desk's screen, not a failed request." | side-effect | P0 |
| REQ-STF-121 | code `lib/assign/index.ts:435-439` | `notifyTechnician` is "Total… every failure is swallowed and logged." | side-effect | P0 |
| REQ-STF-122 | code `lib/assign/index.ts:459` | No technician email → returns without sending | state | P1 |
| REQ-STF-123 | code `lib/assign/index.ts:466` | "First name only — it is all the technician needs to greet her by." | validation | P2 |
| REQ-STF-124 | code `lib/assign/index.ts:467` | The service name is picked in **`ar`** unconditionally — `staff` carries no `lang` | validation | P1 |

## `lib/assign/email.ts` — the technician's mail

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-STF-140 | code `lib/assign/email.ts:9-13` | "**Bilingual labels rather than a language choice.** `staff` carries no `lang` column… each label carries both languages and every technician can read it." | validation | P0 |
| REQ-STF-141 | code `lib/assign/email.ts:31` | `localTime` is the Riyadh wall clock, `HH:MM` | validation | P0 |
| REQ-STF-142 | code `lib/assign/email.ts:37,44` | Every null field renders as an em dash, never as `null` or blank | validation | P1 |
| REQ-STF-143 | code `lib/email/html.ts:7` | "Customer and staff data lands inside an HTML document — never interpolate it raw." | validation | P0 |
| REQ-STF-144 | code `lib/assign/email.ts:5-7` | Tables for layout, inline styles only, no web fonts, no external images | validation | P2 |

## `lib/notify/`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-CUS-160 | code `lib/notify/index.ts:48-52` | "A paid booking must confirm whether or not the receipt goes out, so this swallows errors and returns them instead of throwing." | side-effect | P0 |
| REQ-CUS-161 | code `lib/notify/index.ts:56-57` | An empty or whitespace-only `to` is `{ok:false}` and **not** an error — "plenty of customers give one contact, not both" | validation | P0 |
| REQ-CUS-162 | code `lib/notify/index.ts:44-46` | The driver is chosen by `getDriver()`, today always `logDriver`; `NOTIFY_DRIVER` is not read yet | side-effect | P1 |
| REQ-CUS-163 | code `lib/notify/log.ts:3-7` | "Running with this driver means customers receive nothing" — the log driver always answers `{ok:true}` | side-effect | P1 |
| REQ-CUS-164 | code `lib/notify/customer.ts:20-45` | `notifyCustomer` resolves the address **from `customers.id`**, bails with no address, swallows everything | authz | P0 |
| REQ-CUS-165 | code `lib/notify/customer.ts:22-24` | "Awaited but never allowed to fail its caller" | side-effect | P0 |
| REQ-CUS-166 | code `lib/notify/customer.ts:42` | Language is `customers.lang`, defaulting to `ar` | validation | P0 |
| REQ-CUS-167 | glossary "Locales" | "Both language halves must exist on every P0 flow — a missing `ar` key is a blank screen for the primary audience, not a fallback." | validation | P0 |
| REQ-CUS-168 | skill Phase 7 (uploads/notifications) | "recipient address can't be overridden by user input" | authz | P0 |

## `lib/email/`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-JOB-180 | code `lib/email/index.ts:29-31` | "Never throws — mail is a side effect of work that has already happened… so a provider outage must never turn a completed transaction into an error." | side-effect | P0 |
| REQ-JOB-181 | code `lib/email/index.ts:19-24` | `activeTransport()` is `smtp` only when `SMTP_HOST`, `SMTP_USER` **and** `SMTP_PASSWORD` are all set and non-blank | validation | P0 |
| REQ-JOB-182 | code `lib/email/index.ts:36-42` | Unconfigured → `{ok:false, reason:"not-configured"}`, a warning, and **no transport import** | side-effect | P0 |
| REQ-JOB-183 | code `lib/email/index.ts:32-34` | "The transport is imported lazily: nodemailer opens TCP sockets and cannot be bundled into an Edge route" | side-effect | P2 |
| REQ-JOB-184 | code `lib/email/smtp.ts:55` | `address()` strips `" < > \ CR LF` from the display name — header injection through a customer's name | validation | P0 |
| REQ-JOB-185 | code `lib/email/smtp.ts:69-70` | "Most relays refuse a From that isn't the authenticated mailbox, so this falls back to the SMTP user" | validation | P1 |
| REQ-JOB-186 | code `lib/email/smtp.ts:86-90` | A relay that accepts the message but rejects a recipient → `{ok:false, reason:"rejected"}` | state | P1 |
| REQ-JOB-187 | code `lib/email/smtp.ts:97-99` | 5xx / auth failures are `rejected` (ours); everything else is `failed` (retryable) | state | P1 |
| REQ-JOB-188 | code `lib/email/types.ts:23-28` | The three `ok:false` reasons and what each means | validation | P1 |
| REQ-JOB-189 | code `lib/email/html.ts:8-14` | `esc` escapes `& < > "` — and **not** `'` | validation | P0 |

## `lib/reviews/invite.ts`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-REV-200 | code `lib/db/schema.ts:659-661` | "One invitation per booking, decided by the database rather than by a read that two concurrent End presses could both pass." | side-effect | P0 |
| REQ-REV-201 | code `lib/reviews/invite.ts:22-27` | "The insert comes first and decides everything… a receptionist who presses End twice, or an action that gets retried, cannot produce two emails." | side-effect | P0 |
| REQ-REV-202 | docs/REVIEWS-AND-PROMOS.md:L339-345 | "**Press completed again**… **Expect: no second email.**… `select count(*) … -- 1`" | side-effect | P0 |
| REQ-REV-203 | code `lib/reviews/invite.ts:3-7` | "Deliberately total… Every failure below is swallowed and logged. Nothing here is allowed to throw into setBookingStatus." | side-effect | P0 |
| REQ-REV-204 | code `lib/reviews/invite.ts:56-60` | "Walk-ins and phone bookings legitimately have no address. The row stays — it records that this appointment was never asked" | state | P0 |
| REQ-REV-205 | docs/REVIEWS-AND-PROMOS.md:L347-351 | "Complete a **walk-in** booking, which has no email address. Expect: no mail and no error. The review row is still created" | state | P0 |
| REQ-REV-206 | code `lib/reviews/invite.ts:15-16` | Outcomes are exactly `already-invited \| no-email \| not-found \| not-configured \| failed` | validation | P1 |
| REQ-REV-207 | code `lib/reviews/invite.ts:62-68` | The invitation renders in the **customer's** `lang`, defaulting to `ar`, with the service name in that language | validation | P0 |
| REQ-REV-208 | code `lib/reviews/invite.ts:75` | `replyTo` comes from `MAIL_REPLY_TO`, never from data | authz | P1 |
| REQ-REV-209 | code `lib/reviews/invite.ts:76` | Tagged `review-invite` | validation | P2 |

## `lib/reviews/email.ts`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-REV-220 | code `lib/reviews/email.ts:13-16` | "The five stars are real links, one per score, each landing on the review page with that rating pre-selected." | validation | P0 |
| REQ-REV-221 | code `lib/reviews/email.ts:97-99` | "The stars are text, not images — a remote image is blocked by default in most clients" | validation | P1 |
| REQ-REV-222 | code `lib/reviews/email.ts:86` | The link is absolute (`siteOrigin()`) and the token is `encodeURIComponent`-escaped | validation | P0 |
| REQ-REV-223 | code `lib/reviews/email.ts:33-56` | Both `ar` and `en` halves exist for every string; `ar` is RTL | validation | P0 |
| REQ-REV-224 | code `scripts/check-reviews.ts:60-70` | Customer text in the mail is escaped — a `<script>` in a name arrives as text | validation | P0 |

## `POST /api/reviews`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-REV-240 | code `app/api/reviews/route.ts:3-9` | "Auth is the token in the emailed link and nothing else… The guards are the throttle below and the single-use rule — a review is answered once." | authz | P0 |
| REQ-REV-241 | code `lib/db/schema.ts:641-646` | "Its own random value rather than the booking code: that code travels in forwarded email and is printed on the ticket, and this one opens a write." | authz | P0 |
| REQ-REV-242 | code `app/api/reviews/route.ts:29-31` | Throttled at 5 per IP per minute → `429 {error:"too-many"}` | authz | P0 |
| REQ-REV-243 | code `app/api/reviews/route.ts:33-37` | Malformed JSON → `400 {error:"invalid-json"}` | validation | P1 |
| REQ-REV-244 | code `app/api/reviews/route.ts:39-40` | Schema failure → `400 {error:"invalid"}` | validation | P0 |
| REQ-REV-245 | code `app/api/reviews/route.ts:18` | `serviceRating` is an integer 1–5, required | validation | P0 |
| REQ-REV-246 | code `app/api/reviews/route.ts:22` | `techRating` is the same range, nullable and optional — "Skippable" | validation | P0 |
| REQ-REV-247 | code `app/api/reviews/route.ts:23` | `comment` is trimmed, at most 1000 chars, nullable and optional | validation | P0 |
| REQ-REV-248 | code `app/api/reviews/route.ts:21` | `token` must be a uuid | validation | P0 |
| REQ-REV-249 | code `app/api/reviews/route.ts:45-58` | "One statement, so it needs no transaction to be atomic. Guarded on `submitted_at is null` as well as the token: two taps on a slow connection must not overwrite the first answer with the second." | side-effect | P0 |
| REQ-REV-250 | code `app/api/reviews/route.ts:60-63` | "Already answered, or no such token. Deliberately one answer for both: a caller walking the token space learns nothing from the difference." → `409 {error:"already-submitted"}` | authz | P0 |
| REQ-REV-251 | code `app/api/reviews/route.ts:53` | An empty/whitespace comment is stored as `null`, not `""` | validation | P1 |
| REQ-REV-252 | docs/REVIEWS-AND-PROMOS.md:L382-386 | "Reload the same link. Expect: still the thank-you page, still read-only. The API answers `409` and does not overwrite." | state | P0 |
| REQ-REV-253 | code `lib/db/schema.ts:655` | "Null while unanswered; set once, and the form is read-only afterwards." | state | P0 |

## `/review/[token]`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-REV-270 | code `app/(site)/review/[token]/page.tsx:3-6` | "The token is the address — its own random value, not the booking code… No lookup form and no login" | authz | P0 |
| REQ-REV-271 | code `app/(site)/review/[token]/page.tsx:40` | An unknown token → `notFound()` | authz | P0 |
| REQ-REV-272 | code `app/(site)/review/[token]/page.tsx:42-45` | "`?r=4` from the star… Anything else is ignored rather than rejected — a mangled link should still open the form." | validation | P1 |
| REQ-REV-273 | code `app/(site)/review/[token]/page.tsx:33-35` | The technician name is a **join through the booking**, not a snapshot | validation | P1 |
| REQ-REV-274 | code `app/(site)/review/[token]/page.tsx:53-63` | An answered review renders read-only with the stored scores | state | P0 |
| REQ-REV-275 | Phase 6.6 (RSC boundary) | The props handed to the client component carry no customer email, phone, booking code or id | authz | P0 |

---

## Ambiguities and contradictions — raised, not interpreted

| # | Where | The problem |
|---|---|---|
| A1 | `app/api/cron/refill-reminders/route.ts:88-90` vs `:93-94` | The comment says "Run daily and every booking is nudged once", and the `ponytail:` note directly below only worries about a **missed** run. Neither addresses a **double** run: nothing dedupes, so two runs on the same day send the same customer the same nudge twice. `docs/DAY-START-ASSIGNMENT.md` states the opposite property for the other jobs ("Safe to run more than once"). Logged as BUG-JOBS-002; **not** interpreted as spec either way. |
| A2 | `lib/staff-codes.ts:25-29` vs glossary "Time" | `monthWindow` uses `Date.UTC` months while every other date rule in the repo is Riyadh (`lib/time.ts`). Between 21:00 and 24:00 UTC on the last day of a month the two disagree. `docs/` never states which calendar a staff code's month is. Logged as BUG-JOBS-003. |
| A3 | `app/api/cron/tech-reminders/route.ts:17-20` vs `:58-66` | The header promises "Sent once, ever"; the implementation stamps with an unconditional `UPDATE … WHERE id = ?` and no lock, so two overlapping runs both select the row and both send. Logged as BUG-JOBS-001. |
| A4 | `docs/REVIEWS-AND-PROMOS.md:L104-107` | "**Nothing in this application assigns a technician to a booking.** `bookings.technician_id` exists and has always been null." Contradicted by `docs/DAY-START-ASSIGNMENT.md` and `lib/assign/`, which do exactly that. Stale doc, not a code bug — the join it describes is still right. |
| A5 | `app/api/cron/refill-reminders/route.ts:129` | Returns `{scanned, sent}` with no `ok` field, where the other three return `{ok:true, …}`. No doc states either shape. Characterized, not corrected. |
| A6 | `docs/DAY-START-ASSIGNMENT.md:L332` ("the two cron endpoints") | Written when there were two; there are four. Cosmetic. |

## Documentation gaps — security cases with no requirement in `docs/`

Per Phase 9: a security case with no REQ is a documentation gap. These need a
line in `docs/` as well as a test.

- **G1** — no doc anywhere states that the cron secret comparison is `!==` on a
  string and therefore **not constant-time**. Cited: `app/api/cron/*/route.ts:35`.
- **G2** — no doc states the `x-middleware-subrequest` (CVE-2025-29927) posture
  for the cron routes. They are safe because each re-checks the secret itself,
  but that is an accident of `middleware.ts`'s matcher (`/admin/:path*`), which
  does not cover `/api/cron`.
- **G3** — no doc states that `notify()`'s recipient can never come from caller
  `data`. It cannot, but nothing says so.
- **G4** — `NotifyTemplate` names five templates and no `ar`/`en` copy exists for
  any of them in either language. Glossary REQ-CUS-167 demands both halves. The
  gap is invisible today because the log driver prints `data` raw.
