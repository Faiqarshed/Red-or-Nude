# The test suite

`npm test` → `vitest run`. 673 cases across 16 files, against real local
Postgres. All of them pass: every bug the suite found has been fixed.

```
npm test                      # everything
npx vitest run tests/auth     # one area
npx vitest run -t "takeover"  # one case
npm run test:watch
```

## How it is wired

| Piece | What it does |
|---|---|
| `vitest.config.mts` | `@/` alias, `server-only` stubbed, `next/server` aliased, `next-auth` inlined, files run sequentially against one database |
| `tests/setup.ts` | Imports `scripts/_test-db.ts` before any test module loads |
| `tests/helpers/fixtures.ts` | `branch()` / `service()` / `customer()` / `staff()` / `booking()`, deleting only rows they created |
| `tests/helpers/app.ts` | Cookie jar, session actor, `revalidatePath` recorder, request builders |
| `tests/harness.test.ts` | Proves all of the above before anything else runs |

Two rules that are not negotiable:

1. **Never `db.delete(table)` without a `WHERE` naming ids you created.** The
   gate at `scripts/_test-db.ts` exists because a check script deleted eighty
   real bookings on 2026-09-01. Fixtures delete by id for the same reason.
2. **A test that finds a real bug is reported, not edited to pass.** It gets an
   `it.fails` asserting correct behaviour, a characterization test pinning what
   happens today, and an entry in a `known-bugs-*.md` file.

The thirteen `check:*` scripts under `scripts/` still work and are untouched.
Where they already cover something, the suites cite them rather than duplicating.

## Areas

| Area | File | Cases | Covers |
|---|---|---|---|
| auth | `tests/auth/accounts.test.ts` | 24 | register / verify / otp, signup tickets, session salt separation, blocking |
| booking | `tests/booking/concurrency.test.ts` | 15 | the `reserveStations` row lock, slot boundaries, capacity |
| lifecycle | `tests/lifecycle/ownership.test.ts` | 19 | `refuseBookingAction`, the cancellation window, the open read |
| lifecycle | `tests/lifecycle/status.test.ts` | 13 | who may set which status, check-in guard, the floor's three stamps |
| money | `tests/money/maths.test.ts` | 25 | halalas, inclusive VAT, group splits |
| money | `tests/money/confirm.test.ts` | 14 | charge once, replay, group bill, decline leaves the hold |
| rewards | `tests/rewards/ledgers.test.ts` | 21 | gift-card balance vs ledger, loyalty's filtered SUM |
| admin | `tests/admin/rbac-matrix.test.ts` | 342 | 43 server actions × signed-out and all four roles |
| jobs | `tests/jobs/cron-auth.test.ts` | 39 | four cron routes × eight refusals |
| schema | `tests/schema/constraints.test.ts` | 282 | every unique, FK, notNull, enum and delete rule on 34 tables |
| lifecycle | `tests/lifecycle/self-service.test.ts` | 39 | reschedule and refill at the route, the refill window, `claimedWindows` |
| rewards | `tests/rewards/promos.test.ts` | 29 | promo window through Postgres, the lookup, `countPromoUse`, the cap race, re-pricing at the charge |
| reviews | `tests/reviews/ratings.test.ts` | 22 | the `reviews_booking_unique` race, the token, submit-twice |
| assign | `tests/assign/floor.test.ts` | 17 | `offOn`, `pickTechnician` eligibility, `assignDay`'s three filters |
| i18n | `tests/i18n/dictionary.test.ts` | 7 | every `ar` key has an `en` twin, and the reverse |

## Findings

All six are fixed. Each was reported first, demonstrated, and fixed in its own commit.

| ID | Sev | What | Fix |
|---|---|---|---|
| [BUG-AUTH-001](known-bugs-auth.md) | **P0** | Account takeover: prove any inbox, post the victim's phone number, inherit their row, bookings and points | Phone is a label — it may claim a guest row, never open an account. `setWhere` makes it race-proof |
| [BUG-BOOK-001](known-bugs-booking.md) | P1 | `POST /api/bookings` trusted `startsAt` — the past, before opening, past closing, closed days and closures all accepted | Past refused at the route; hours and closures via `refuseOutsideHours`, behind a flag only the public route sets |
| [BUG-LIFE-001](known-bugs-lifecycle.md) | P2 | The dev login bypass switched itself on whenever `NODE_ENV` was not `production` | Needs `ADMIN_DEV_LOGIN=1` as well — asked for, not merely not-prevented |
| [BUG-JOBS-001](known-bugs-jobs.md) | P2 | `staff-codes` was never in `vercel.json`, so monthly staff codes had never been minted | Scheduled `0 1 1 * *`, the entry its own comment specifies |
| [BUG-AUTH-002](known-bugs-auth.md) | P3 | A phone number with extra digits was silently truncated and accepted | The cap stays on the field; the validator counts what was actually sent |
| [BUG-MONEY-006](known-bugs-money.md) | P3 | `sarToHalalas` rounded half-halalas in whichever direction IEEE-754 landed | Snap to four decimals first, then round — consistently half-up |

Six more were found by `/code-review` on this branch — four of them mistakes in
this work, two pre-existing holes in the test-database safety gate. All fixed;
see the commit log.

The five surfaces added on 2026-09-03 (reschedule, refill, promos, reviews,
assignment eligibility, localization) found **no new bugs**. What they turned up
instead was four pieces of behaviour that are deliberate and undocumented, each
pinned with a `// @characterization` test rather than asserted as spec:

| Where | Pinned |
|---|---|
| `lib/promo.ts:128-136` | The cap is checked at hold and counted at confirmation, so two customers racing the last use of a capped code both get it. A documented, accepted ceiling (REQ-PRM-011 / A01). |
| `lib/promo.ts:75` | A negative code `value` is floored at zero rather than refused, so a mistyped code cannot *increase* a bill (REQ-PRM-035). |
| `lib/reviews/invite.ts` | The insert runs before the booking is read, so an unknown booking id trips the foreign key and is caught as `failed` — the declared `not-found` outcome is unreachable (REQ-REV-206). |
| staff codes | A promo code carrying a `staff_id` is an ordinary promo code; nothing links it to an HR record, so anyone it is forwarded to can spend it (REQ-STC-009 / REQ-PRM-A02). |

Each `known-bugs-*.md` also has a "not bugs" section recording what was
investigated and found sound, so the same ground is not walked twice.

## Ground rules for adding to this

- Read `docs/_testing/glossary.md` first — it has the domain's own nouns, the
  capability matrix, the ownership chains and the two auth systems.
- **The source is spec too**, not just `docs/`. `lib/db/schema.ts` is mostly
  comment and most of the rules live there. See `AGENT-BRIEF.md`.
- Assertion messages are sentences in salon vocabulary: *"the front desk cancels
  bookings, it does not delete them"*, not *"expected false"*.
- Every security test names the attack it performs.
- Authorization tests must stub `NODE_ENV=production`, or the dev fallback signs
  them in as CEO and they pass for the wrong reason (BUG-LIFE-001).

## Not covered

Honest gaps, in rough priority order. Nothing here is known to be broken — it is
simply untested.

- **Gift card purchase and the station QR flow** end to end. The QR flow's
  timing is now covered at the route; the rest of it is not.
- **`/review/[token]` and every other page component.** The suite has no JSX
  transform — `vitest.config.mts` configures no React plugin, deliberately,
  because nothing else here renders components. Importing a `.tsx` page fails to
  parse, so REQ-REV-270…275 (including the Phase 6.6 payload check on the review
  page) are N/A at this layer rather than untested by oversight. Adding a
  component harness is a change to the shared config.
- **RSC payload leaks** (Phase 6.6) and **cache poisoning** (6.7) — not reached
  beyond the JSON boundaries the route tests already assert on.
- **`planAssignments` under a pre-assigned floor.** The `ponytail:` note on it
  warns that greedy first-fit "can come back null where reshuffling earlier ones
  would have fitted it". No such case was constructible: colouring intervals in
  start order is optimal, and every surplus found was genuinely unassignable.
  Left untested rather than faked.
- **Mutation testing.** Coverage says which lines ran; nothing says which
  assertions would survive a mutant.

## The one thing left open on purpose

A phone number attached to a **guest** row — someone who gave it at the desk and
never made an account — can still be claimed by a stranger, who inherits that
guest's walk-in bookings. No account, no login, no points.

It is the same behaviour that lets a real walk-in keep her history when she signs
up online later, which is why it was left. Closing it means dropping the guest
merge, requiring staff confirmation, or verifying the phone by SMS.

**Decided 2026-09-03: left open.** SMS is the only fix that does not cost the
feature, and no provider is wired — `lib/notify/index.ts:4` still has Unifonic
vs Meta's Cloud API open. BUG-AUTH-001 now carries a plain-words table of the
trade (one code and a small hole, or two codes and the friction), a worked
example, and the trap in doing half of it: whichever channel is *proved* must be
the only one allowed to resolve an account, or the same hole reopens facing the
other way.
