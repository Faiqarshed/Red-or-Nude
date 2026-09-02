# Surface map — money

Phase 2. Enumerated from the **code** first (every export, every branch, every
early return, every guard), then reconciled against `docs/`. Per the coordinator
correction, a comment is a spec source, so "code without spec" below means
"no statement anywhere — neither `docs/` nor a comment".

## Route handlers

| Method + path | File | Mutates | Auth | Amount from |
|---|---|---|---|---|
| `POST /api/payments/confirm` | `app/api/payments/confirm/route.ts` | `payments` (insert + update), `bookings.status`/`ticketNo`, `ticket_counters`, `loyalty_txns`, `promo_codes.used_count` | **none** — the booking code is the bearer token | server, `SUM(bookings.total_halalas)` |
| `POST /api/gift-cards` | `app/api/gift-cards/route.ts` | `payments` (insert), `gift_cards`, `gift_card_txns` | none | **client**, `amountSar` 50–2000, `sarToHalalas()` |

Both are `export const dynamic = "force-dynamic"`. Neither has a rate limit
(`/api/bookings` has one; these two do not — see CWS-7).

## Server actions

None in this area. The two client pages under `app/(site)/booking/payment/` and
`app/(site)/gift-card/payment/` are `"use client"` and reach the server only
through the two routes above, so they carry no server-side money logic and no
authorization of their own.

## Exported functions

| Export | File | Branches / early returns |
|---|---|---|
| `HALALAS_PER_SAR`, `DEFAULT_VAT_PERCENT` | `lib/money.ts` | constants `100`, `15` |
| `sarToHalalas` | `lib/money.ts` | `Math.round(sar * 100)`, no guard |
| `halalasToSar` | `lib/money.ts` | `h / 100`, **returns a float by design** |
| `formatSAR` | `lib/money.ts` | decimals shown iff `h % 100 !== 0`, unless overridden |
| `vatOn` | `lib/money.ts` | VAT **added to** an exclusive subtotal. No caller in the money area |
| `vatIncludedIn` | `lib/money.ts` | VAT **extracted from** an inclusive total |
| `shareAmount` | `lib/money.ts` | `amount <= 0` → zeros; `weightTotal <= 0` → zeros; else floor + largest remainder |
| `splitGroupPrice` | `lib/money.ts` | `grossTotal > 0` guard, one `Math.round`, delegates to `shareAmount` |
| `getDriver` | `lib/payments/index.ts` | **no branch** — always `fakeDriver` |
| `fakeDriver.charge` | `lib/payments/fake.ts` | `simulate === "decline"` → failed, else paid; `providerRef = input.ref` |
| `fakeDriver.refund` | `lib/payments/fake.ts` | always `refunded` |
| `confirmBookingPayment` | `lib/payments/confirm.ts` | 5 early returns + a `catch`: `not-found`, `expired` (pre-charge), `failed` (charge threw), `payment-declined`, `expired` (post-charge catch) |
| `refundBookings` | `lib/payments/refund.ts` | 5 `ok:false` exits: empty ids, no paid rows, null providerRef, driver declined, `catch` |
| `buildBookingInvoice` | `lib/invoice/data.ts` | `null` on empty ids, on no rows, on no customer email |
| `sendBookingInvoice` | `lib/invoice/send.ts` | `no-email`, `not-configured`, `failed`, `sent` |
| `renderInvoiceEmail` | `lib/invoice/template.ts` | `lang` picks the `T` table and flips `dir`/`start`/`end` |

## Tables

**`payments`** (`lib/db/schema.ts:668`)

| Column | Type | Constraint |
|---|---|---|
| `id` | uuid | PK, `defaultRandom()` |
| `booking_id` | uuid | FK → `bookings.id` **ON DELETE SET NULL**, nullable |
| `gift_card_id` | uuid | **no FK** — a bare uuid column |
| `provider`, `provider_ref` | text | nullable, **no unique index** |
| `method` | `payment_method` enum | nullable |
| `amount_halalas` | integer | `notNull`, **no CHECK** |
| `status` | `payment_status` enum | `notNull`, default `pending` |
| `raw` | jsonb | nullable |
| `created_at`, `updated_at` | timestamptz | `notNull`, `defaultNow()` |

**`refunds`** (`lib/db/schema.ts:681`)

| Column | Type | Constraint |
|---|---|---|
| `id` | uuid | PK |
| `payment_id` | uuid | `notNull`, FK → `payments.id` **ON DELETE CASCADE** |
| `amount_halalas` | integer | `notNull`, **no CHECK** |
| `reason` | text | nullable |
| `actor_id` | uuid | FK → `staff.id` ON DELETE SET NULL |
| `created_at` | timestamptz | `notNull`, `defaultNow()` — **no `updated_at`** |

No unique constraint anywhere on either table. Nothing stops two `payments` rows
sharing a `provider_ref` for the same `booking_id`, and nothing stops two
`refunds` rows against one payment.

## External dependencies

| Dependency | How it is reached | Test approach |
|---|---|---|
| Payment gateway | `getDriver()` → `fakeDriver` | the repo's own fake driver; `vi.mock("@/lib/payments/index")` for the failure shapes it cannot produce |
| SMTP | `sendMail` → `lib/email/index.ts` | unconfigured in the test env, so it returns `{ok:false, reason:"not-configured"}` without a socket |
| `notify()` | `lib/notify/log.ts` | log-only sink, already inert |

## Environment variables

`PAYMENT_DRIVER`, `MOYASAR_PUBLISHABLE_KEY`, `MOYASAR_SECRET_KEY`,
`MOYASAR_WEBHOOK_SECRET` — all four are declared in `.env.example` and
`.env.local`. **`grep -rn "MOYASAR" app lib` returns nothing.** Not one of them
is read by any source file. `NODE_ENV` is read, to strip `simulate`.

`SMTP_*`, `MAIL_FROM_*`, `MAIL_REPLY_TO`, `SITE_URL` reach this area through
`lib/email`.

No money-relevant secret is under a `NEXT_PUBLIC_` name.

## Auth model

There is none on either money route. The booking code is the bearer credential
for confirm; the gift-card purchase is fully anonymous. That is deliberate for
confirm (an anonymous customer must be able to pay for the hold they just
created) and it is why the amount must be server-derived — which it is.

---

# Reconciliation

## 1. Spec without code — `docs/` promises it, nothing implements it

| # | Promised at | Reality |
|---|---|---|
| SWC-1 | `docs/PAYMENTS-MOYASAR.md:187` — `app/api/payments/webhook/route.ts`, "Check `secret_token`" | The file does not exist. No route under `app/api/payments/` other than `confirm`. **No signature verification code exists anywhere.** P0, BUG-MONEY-001 |
| SWC-2 | `docs/PAYMENTS-MOYASAR.md:243` — "`getDriver()` branches on `PAYMENT_DRIVER`" | It does not branch. `PAYMENT_DRIVER=moyasar` in `.env.local` is inert. P0, BUG-MONEY-002 |
| SWC-3 | `docs/PAYMENTS-MOYASAR.md:144` — "Settle must be idempotent" | There is no settle. `confirmBookingPayment` is idempotent *sequentially* (the `pending` guard) and **not** concurrently. P0, BUG-MONEY-003 |
| SWC-4 | `docs/PAYMENTS-MOYASAR.md:176` — `verify(providerId)` on `PaymentDriver` | `PaymentDriver` has `charge` and `refund` only |
| SWC-5 | `docs/PAYMENTS-MOYASAR.md:158-162` — the server-side amount comparison on settle | No comparison exists, because no gateway-supplied amount ever reaches the server. Vacuously satisfied today; becomes a live hole the moment a driver lands |
| SWC-6 | `docs/PAYMENTS-MOYASAR.md:193-196` — guard the sweeper with "has no pending payment row" | `sweepExpiredHolds` (`lib/bookings.ts:541`) still cancels on age alone |
| SWC-7 | `docs/PAYMENTS-MOYASAR.md:167` — `startBookingPayment()` / `settleBookingPayment()` split | `confirmBookingPayment` is still one function |

The Moyasar doc disclaims itself in line 6 ("Nothing here is built yet"), so
SWC-4/6/7 are *planned* work, not regressions. SWC-1/2/3 are listed as P0 anyway
because `MOYASAR_WEBHOOK_SECRET` and `PAYMENT_DRIVER=moyasar` are already
**shipped in `.env.example`**, which makes the gap operationally invisible.

## 2. Code without spec — the largest list

Every row here gets a `// @characterization` test pinning today's behaviour.

| # | Surface | Undocumented behaviour |
|---|---|---|
| CWS-1 | `vatOn` | Exported, VAT-**exclusive**, and called by nothing in the money area. The whole codebase is VAT-inclusive. An unused second VAT function next to the right one is a footgun; no doc mentions it exists |
| CWS-2 | `vatIncludedIn` on a negative total | No guard. `vatIncludedIn(-100, 15)` returns `-13` |
| CWS-3 | `vatIncludedIn(1, 15)` | Returns `0`. VAT on one halala is nothing, so subtotal == total. Undocumented but correct |
| CWS-4 | `splitGroupPrice(g, percent)` for `percent > 100` or `percent < 0` | No bound. 150% produces **negative totals**; a negative percent is silently a no-op (`shareAmount` floors `amount <= 0` to zeros) |
| CWS-5 | `sarToHalalas` on a fractional riyal | `sarToHalalas(1.005)` is `100`, not `101` — `1.005 * 100` is `100.49999999999999` in IEEE-754. Reachable from the gift-card `amountSar` |
| CWS-6 | `payments.amount_halalas` | No CHECK constraint. A zero or negative payment row inserts cleanly |
| CWS-7 | `POST /api/payments/confirm` | No rate limit, unlike `POST /api/bookings`. An unknown code is a free 404 oracle over the whole code space |
| CWS-8 | `POST /api/payments/confirm` | No authentication of any kind is documented as a decision. The booking code is the credential |
| CWS-9 | `payments.gift_card_id` | Declared as a bare `uuid` with **no foreign key**, unlike `booking_id`. Nothing enforces that it names a real gift card |
| CWS-10 | `payments.provider_ref` | No unique index, so the "one transaction, N rows" invariant is application-level only |
| CWS-11 | `refunds` | No `updated_at` — the only money table without the `stamps` pair |
| CWS-12 | `refunds` | No unique constraint on `payment_id`, so nothing at the DB level stops a double refund row |
| CWS-13 | `refundBookings` | The refund amount can never exceed the original, because it is derived from the paid rows and never taken from a caller. Worth pinning: the guarantee is structural, not a check |
| CWS-14 | `fakeDriver.charge` | Echoes `input.ref` as `providerRef`, so `payments.provider_ref` is our uuid, not a gateway id. Every assertion about `providerRef` today is really an assertion about our own uuid |
| CWS-15 | `buildBookingInvoice` | Puts `customer.phone` into `InvoiceData` although the template renders it nowhere |
| CWS-16 | `buildBookingInvoice` | Reads the **live** `promo_codes.code` and the **live** technician name, but frozen prices. Documented in the comment, absent from `docs/INVOICE-EMAIL.md` |
| CWS-17 | `invoiceNumber` | Uses `getUTCFullYear`/`getUTCMonth`, so an invoice issued 2am Riyadh on the 1st of a month is numbered with the **previous** month |
| CWS-18 | `confirmBookingPayment` | `simulate: "decline"` is honoured by the *library* unconditionally; only the route strips it in production. A future server-side caller inherits no protection |
| CWS-19 | `confirmBookingPayment` | Group members are ordered `createdAt, id`, and tickets are handed out in that order — the invoice's guest order depends on it |
| CWS-20 | `POST /api/gift-cards` | `z.coerce.number()` accepts the **string** `"100"` and the boolean `true` (coerced to 1, then rejected by `.min(50)`) |

## 3. Spec contradicts code — stop and ask

| # | Contradiction | Status |
|---|---|---|
| SCC-1 | `lib/payments/confirm.ts` comment: the per-member UPDATE row count is "the whole concurrency story". The `WHERE` has no `status` predicate, so the count is always 1 and two concurrent confirms both succeed | **Reported, not fixed.** BUG-MONEY-003 |
| SCC-2 | `docs/PAYMENTS-MOYASAR.md:243` present-tense "branches on `PAYMENT_DRIVER`" vs `lib/payments/index.ts:57` "once there is a second driver" | **Reported.** BUG-MONEY-002 |
| SCC-3 | `lib/db/schema.ts:73` declares `partially_refunded`; `lib/payments/refund.ts` never writes it | **Reported.** BUG-MONEY-005 |
| SCC-4 | `lib/payments/index.ts:2-6` says "Moyasar vs Tap is still an open decision"; `docs/PAYMENTS-MOYASAR.md:9` says "The provider is decided: **Moyasar**" | Stale comment. Cosmetic, no behaviour rides on it |
