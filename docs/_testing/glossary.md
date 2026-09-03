# Testing glossary — Red or Nude

Phase 0 of `nextjs-drizzle-hardening`. Every case ID, test name and fixture in
`tests/` uses the vocabulary below, which is the codebase's own. Derived from
`lib/db/schema.ts`, `lib/auth/rbac.ts`, `middleware.ts` and `app/`.

The salon is a Riyadh nail/lash studio. It takes **bookings** against **stations**
(chairs) at a **branch**, staffed by **technicians**, run from a **front desk**.

---

## Entities

`<ENT>` codes are the prefix for every REQ and TC id.

| `<ENT>` | Table | What it is |
|---|---|---|
| `STF` | `staff` | Who works here. Email-unique, role-bearing, optionally branch-pinned. |
| `TOF` | `staff_time_off` | A staff member's days off. Inclusive date range. |
| `AUD` | `audit_log` | Who changed what. The observability backstop. |
| `BRN` | `branches` | A salon location. |
| `BHR` | `branch_hours` | Weekly opening hours. **weekday 0 = Saturday.** |
| `STA` | `stations` | Chairs. Capacity for a slot = count of active stations. Carries a public `qr_token`. |
| `CLO` | `closures` | Eid, Ramadan, maintenance. Null `branch_id` = every branch. |
| `SVC` | `services` | What is sold. Price, duration, refill window. |
| `ADD` | `addons` | Extras. |
| `RMV` | `removal_types` | Removal options. |
| `SAD` | `service_addons` | Which add-ons go with which service. Empty = all. |
| `DCO` | `design_collections` | Nail-design groupings. |
| `DES` | `designs` | Individual designs. |
| `CUS` | `customers` | The customer. **An account *is* a customer row with `email_verified_at` set** — there is no accounts table. |
| `BKG` | `bookings` | The central entity. |
| `TIC` | `ticket_counters` | Per-branch, per-day queue numbers ("A45"). |
| `OTP` | `otps` | One-time codes. Subject is `booking:<uuid>` or `email:<address>`. |
| `BAD` | `booking_addons` | Add-on snapshot on a booking. Composite PK, no `id`. |
| `REV` | `reviews` | One row per finished appointment, created at *invitation* not answer. |
| `PAY` | `payments` | Money in. |
| `RFD` | `refunds` | Money back. |
| `GCD` | `gift_card_designs` | Gift card artwork. |
| `GCV` | `gift_card_values` | Sellable denominations. |
| `GFT` | `gift_cards` | Issued cards. Carries a running `balance_halalas`. |
| `GTX` | `gift_card_txns` | Gift card ledger. |
| `LOY` | `loyalty_txns` | Points ledger. **No balance column** — balance is a filtered SUM. |
| `PRM` | `promo_codes` | Discounts. A staff monthly code is a promo code with `staff_id` set. |
| `CNT` | `content_blocks` | Dictionary promoted to DB. |
| `OFR` | `offers` | Marketing offers. |
| `FAQ` | `faqs` | FAQ entries. |
| `PGE` | `pages` | CMS pages. |
| `SUB` | `subscribers` | Newsletter. |
| `MED` | `media` | Uploads. |
| `SET` | `settings` | Key/value config. |

---

## Lifecycles

Every enum in `lib/db/schema.ts:44-85`. Phase 5 item 15 applies to each: N states
means N×N transitions to account for, and every transition *not* listed as legal
must be rejected.

**`booking_status`** — `pending → confirmed → checked_in → in_progress → completed`,
with `cancelled` and `no_show` as exits.

- `checked_in` = customer is here, handed to a technician, not started. The gap
  between this and `in_progress` **is the salon's waiting time** (brief §3.2).
- `finished_at` (technician says done) is **not** `completed` (receptionist closes
  the ticket). Two different moments, deliberately.
- `pending` is an unpaid hold.

**`booking_source`** — `web` | `walk_in` | `phone`

**`payment_status`** — `pending` | `paid` | `failed` | `refunded` | `partially_refunded`

**`payment_method`** — `card` | `mada` | `stc` | `apple`

**`gift_card_status`** — `active` | `redeemed` | `expired` | `cancelled`

**`promo_type`** — `percent` | `fixed` (value is percent points, or halalas when fixed)

**`staff_role`** — `ceo` | `admin` | `receptionist` | `technician`

**`lang`** — `ar` | `en`

Unstamped lifecycle-ish columns that behave like states and need the same
treatment: `customers.blocked`, `customers.email_verified_at`,
`bookings.checked_in_at` / `started_at` / `finished_at` / `tech_notified_at`,
`reviews.submitted_at`, `otps.consumed_at`, `*.active`.

---

## Roles and capabilities

Matrix at `lib/auth/rbac.ts:47`. 25 capabilities, 4 roles. Enforcement is
`requireCan(cap)` in `lib/auth/guard.ts` — **middleware is explicitly not a
security boundary** (`middleware.ts:1-3`), it only redirects anonymous visitors
away from `/admin/:path*`.

Non-obvious grants that tests must pin, because they read backwards and were
changed under pressure:

| Rule | Why it is easy to get wrong |
|---|---|
| `admin` **can** `bookings.delete` but **cannot** `bookings.reschedule` or `bookings.status` | Granted/revoked 2026-08-28 → 2026-09-01. `deleteBooking` refuses anything paid, reviewed or point-earning, so admin can remove a mistake but never a money record. |
| `receptionist` **keeps** `bookings.reschedule` | Taken away 2026-09-01 and given straight back; the alternative at the counter loses the ticket number. |
| `receptionist` has **no** `dashboard.view` | `/admin` renders them the front desk instead. |
| `technician` has **only** `bookings.own` | Their own day and nothing else. |
| `admin` has **no** `settings.manage`, no `audit.view` | Admin is not god mode. |
| `mustHaveBranch(role)` is true for `receptionist` and `technician` | `scopedBranchId` reads a null branch as **"no filter"**, so an unpinned receptionist would silently see every branch. |

`can(null, …)` and `can(undefined, …)` must be false for every capability.

---

## Ownership chains

Where authorization breaks (Phase 6.3 item 13 — walk the *full* chain, don't stop
at the first hop).

| Actor | Chain to the row |
|---|---|
| Customer (account) | `account cookie → readSession → customers.id → bookings.customer_id`. `currentCustomer()` re-reads the row every request, so `blocked` and un-verifying are immediate revocations. |
| Customer (no account) | `booking code + OTP → otps.subject = "booking:<uuid>"`. See `lib/booking-auth.ts`. |
| Staff, branch-scoped | `session.branchId → branches.id → {stations, bookings, branch_hours, closures}`. `scopedBranchId(role, branchId)` returns **null for CEO = no filter**. |
| Technician | `staff.id → bookings.technician_id`. Their two actions are guarded by a WHERE clause, not a post-fetch check. |
| Station QR | `stations.qr_token → station → branch`. Public token on a sticker anyone can photograph; must not address the station anywhere else. |
| Review link | `reviews.token → booking`. Opens a *write*, so it is not the booking code. |
| Gift card | `gift_cards.code → balance`. Bearer instrument — possession of the code is the authorization. |
| Multi-hop to test | `booking → payment → refund`, `booking → review`, `customer → loyalty_txns → booking`, `staff → promo_code (staff_id)`. |

---

## Money

**Every amount is an INTEGER count of halalas. 1 SAR = 100 halalas.** Never float,
never `numeric`. Format with `formatSAR` in `lib/money.ts` — never `toFixed` alone.

- Columns: `price_halalas`, `amount_halalas`, `initial_halalas`, `balance_halalas`,
  `delta_halalas`, `min_total_halalas`, `total_halalas`, `discount_halalas`.
- VAT: 15%, **inclusive** — `vatIncludedIn(total, 15)` extracts it from the total.
- Group bookings: `splitGroupPrice(grosses, discountPercent)` must make the per-guest
  totals sum back to the bill **exactly**, with no rounding drift.
- Gateway: **Moyasar** (`lib/payments/`), with a `fake` driver selected by
  `PAYMENT_DRIVER`. `MOYASAR_WEBHOOK_SECRET` exists → signature verification is
  in scope (Phase 7 money module).
- Gift card balance is a stored running total with a ledger (`gift_card_txns`);
  loyalty balance is **computed** from the ledger with no stored column. Two
  different consistency models, both need tests.

---

## Time

Timezone is **Asia/Riyadh** (`lib/time.ts`), stored UTC-aware.

- All timestamps are `withTimezone: true`. `customers.birthday` is a bare `date`
  on purpose — a Riyadh birthday must not land on the 4th in UTC.
- `branch_hours.opens`/`closes` are bare `time`. **weekday 0 = Saturday.**
- Scheduled work: four cron routes (`assign-day`, `refill-reminders`,
  `staff-codes`, `tech-reminders`), gated by `CRON_SECRET`. The tech reminder
  runs every quarter hour and dedupes on `tech_notified_at`.
- Expiring things: `otps.expires_at`, `gift_cards.expires_at`,
  `promo_codes.starts_at`/`ends_at`, the refill window (`services.refill_days`),
  the cancellation cutoff (`lib/cancellation.ts`), the monthly staff-code window
  (`lib/staff-codes.ts`), the account session cookie.
- Saudi Arabia does **not** observe DST, but the customer's browser may be
  anywhere — a booking made in one TZ and read in another is a real case.

---

## Locales

Bilingual **ar / en**, Arabic-first, **RTL**.

- Localized DB text is `jsonb { ar, en }` (`Localized` in `schema.ts:33`), mirroring
  `Content` in `lib/dictionary.ts` (962 lines).
- `customers.lang` and `staff` emails decide which language a notification is sent in.
- Both language halves must exist on every P0 flow — a missing `ar` key is a blank
  screen for the primary audience, not a fallback.

---

## Tenancy

**Branch-scoped, not multi-tenant.** There is no organisation table. The boundary is
`branch_id`, and the enforcement is `scopedBranchId()`.

The trap: `scopedBranchId` returns `null` for CEO meaning "no filter", and also
returns `null` for a role whose `branchId` is null. A receptionist or technician
saved without a branch therefore reads as *CEO* to every query. `mustHaveBranch()`
exists to stop that and is enforced in two places (the staff form and `saveStaff`) —
a rule enforced in only one of them is a rule with a hole in it.

---

## External dependencies

| Dependency | Env | Test approach |
|---|---|---|
| Postgres | `DATABASE_URL` / `TEST_DATABASE_URL` | Real, local, `*_test`. See `tests/setup.ts`. |
| Moyasar | `MOYASAR_*` | The repo's own `lib/payments/fake.ts` driver, selected by `PAYMENT_DRIVER`. Do not add MSW. |
| SMTP (nodemailer) | `SMTP_*` | `lib/notify/log.ts` already exists as a no-send sink. |
| Supabase Storage | `SUPABASE_*` | `lib/storage/` — stub at the module boundary. |
| Google Gemini | `GEMINI_API_KEY` | `app/api/chat` — stub. |
| Cron caller | `CRON_SECRET` | Shared-secret header; test the unauthenticated path. |
| NextAuth | `AUTH_SECRET`, `AUTH_URL` | Staff side only. Customers use a separate cookie session (`lib/account/session.ts`). |

**Two independent auth systems.** Staff: NextAuth + `lib/auth/guard.ts`. Customers:
own signed cookie + `lib/account/guard.ts`, "deliberately sharing nothing with it".
Every test must be explicit about which one it is exercising.
