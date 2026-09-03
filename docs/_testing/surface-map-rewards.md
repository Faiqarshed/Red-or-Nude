# Surface map — `rewards`

Phase 2 of `nextjs-drizzle-hardening`. Everything in this area that can reduce
what a customer pays, or that hands out spendable value.

The area has **two different consistency models** and the map is organised
around that split, because it is the single most important fact about it:

| | Gift cards | Loyalty |
|---|---|---|
| Balance | Stored column `gift_cards.balance_halalas` | **No column.** A filtered SUM over `loyalty_txns` |
| Ledger | `gift_card_txns` | `loyalty_txns` |
| The rule | "never edit balance without a row here" (schema.ts:730) | "the balance query ignores rows whose booking is cancelled, a no-show, or a hold that has sat unpaid past its window" (schema.ts:752) |
| How value comes back | An explicit compensating ledger row | **Nothing is written.** The filter simply stops counting the dead row |
| Concurrency guard | `SELECT … FOR UPDATE` on the card row | The customer-row lock taken by the booking transaction's upsert |
| Failure mode to test for | Balance drifts from ledger | The filter misses a way a booking can die, and points stay locked forever |

---

## Route handlers

| Method + path | File | Auth | Mutates | Notes |
|---|---|---|---|---|
| `POST /api/promo/quote` | `app/api/promo/quote/route.ts` | **None** — public | nothing | Throttled 10/min per IP. `force-dynamic`. Answers `200` with a refusal reason rather than 4xx. |
| `GET /api/loyalty/quote` | `app/api/loyalty/quote/route.ts` | Customer cookie (`currentCustomer`) | nothing | Signed out returns `{balance: 0, signedIn: false}` — a `200`, not a 401. |
| `POST /api/loyalty/quote` | same | Customer cookie, **401 without** | nothing | Not throttled — the session is the rate limit, by design (route comment L45). |
| `POST /api/gift-cards` | `app/api/gift-cards/route.ts` | **None** — public | `gift_cards`, `gift_card_txns`, `payments` | Charges first, issues second. Sends two emails + a WhatsApp notify. `201` on success. |
| `GET /api/gift-card-image` | `app/api/gift-card-image/route.tsx` | **None** — public | nothing | `runtime = "edge"`. Renders a PNG. Amount clamped 50–2000. |

## Pages

| Path | File | Auth | Notes |
|---|---|---|---|
| `/gift/[code]` | `app/(site)/gift/[code]/page.tsx` | **The code is the authorization** (bearer instrument) | `force-dynamic`. `notFound()` on unknown **and** on `cancelled`. Uppercases and trims the param. |
| `/gift-card` | `app/(site)/gift-card/page.tsx` | None | The builder. Reads `gift_card_values` + `gift_card_designs`. |
| `/gift-card/payment` | `app/(site)/gift-card/payment/page.tsx` | None | Posts to `/api/gift-cards`. |

## Server actions

`app/(admin)/admin/(shell)/gift-cards/actions.ts` — every one calls
`requireCan()` first, before parsing input.

| Action | Capability | Mutates |
|---|---|---|
| `issueCard` | `giftcards.issue` | `gift_cards`, `gift_card_txns`, `audit_log` |
| `adjustCard` | `giftcards.adjust` | `gift_cards`, `gift_card_txns`, `audit_log` |
| `cancelCard` | `giftcards.adjust` | `gift_cards.status` — **no ledger row, and none is needed: the balance is untouched** |
| `addGiftValue` / `deleteGiftValue` | `giftcards.adjust` | `gift_card_values` |
| `saveGiftDesign` / `deleteGiftDesign` | `giftcards.adjust` | `gift_card_designs` |

Staff monthly codes are issued from `app/api/cron/staff-codes/route.ts`
(`CRON_SECRET`) and from the staff screen; both go through
`issueMonthlyCode` / `issueMonthlyCodesForEveryone`.

## Library surfaces

| Module | Exports under test |
|---|---|
| `lib/promo.ts` | `promoRefusal`, `promoDiscount`, `normalizePromoCode`, `quotePromo`, `countPromoUse` |
| `lib/rewards.ts` | `REWARDS`, `rewardFor`, `rewardRefusal`, `rewardDiscount`, `pointsEarned`, `spendableBalance` |
| `lib/loyalty.ts` | `loyaltyBalance`, `quoteReward`, `spendPoints`, `awardPoints` |
| `lib/staff-codes.ts` | `STAFF_CODE_PERCENT`, `monthWindow`, `issueMonthlyCode`, `issueMonthlyCodesForEveryone` |
| `lib/giftcards.ts` | `makeGiftCardCode`, `issueGiftCard`, `adjustGiftCardBalance`, `ledgerBalance` |
| `lib/giftcard/email.ts` | `renderGiftCardEmail`, `sendGiftCardEmails` |
| `lib/giftcard-selection.ts` | `saveGiftSelection`, `loadGiftSelection`, `clearGiftSelection` — browser-only |
| `lib/card.ts` | the whole file; pure, display-only, no server surface |

The **stacking** surface is `createBookings` in `lib/bookings.ts:625-761`. It is
another agent's file, but the order in which discounts land is this area's rule,
so it is tested here through its public behaviour only.

## Tables and constraints

| Table | Constraints that matter here |
|---|---|
| `promo_codes` | `promo_codes_code_unique` on `code`; `staff_id` FK → `staff` `on delete cascade`; `uses` notNull default 0; `type` enum `percent \| fixed` |
| `loyalty_txns` | `customer_id` FK notNull `on delete cascade`; `booking_id` FK **nullable** `on delete cascade`; `delta_points` notNull integer; index on `(customer_id, created_at)`. **No balance column, no unique key — a customer may have any number of rows.** |
| `gift_cards` | `gift_cards_code_unique` on `code`; `design_id` FK `on delete set null`; `initial_halalas` + `balance_halalas` notNull integers; `status` enum `active \| redeemed \| expired \| cancelled` |
| `gift_card_txns` | `gift_card_id` FK notNull `on delete cascade`; `booking_id` FK `on delete set null`; `actor_id` FK → staff `on delete set null`; `delta_halalas` notNull |
| `gift_card_designs` | nothing beyond defaults; `giftCards.designId` is `set null`, so a design can be deleted under a live card |
| `gift_card_values` | nothing beyond defaults |

No CHECK constraint anywhere enforces `balance_halalas >= 0`, and none enforces
`balance = sum(ledger)`. Both are application invariants only — which is exactly
why they are asserted after every mutating test in this area.

## External dependencies

| Dependency | Reached from | Test approach |
|---|---|---|
| Payment driver | `POST /api/gift-cards` → `getDriver()` | `lib/payments/fake.ts` is the only driver wired; `simulate: "decline"` is the decline path and is stripped in production |
| SMTP | `sendGiftCardEmails` | **`.env.local` has live Gmail credentials.** Tests that reach this path clear `SMTP_HOST`/`SMTP_USER`/`SMTP_PASSWORD` first so `activeTransport()` returns `"none"` and nothing leaves the machine. |
| `notify()` | `POST /api/gift-cards` WhatsApp leg | Log-only driver; no stub needed |
| `next/og` | `GET /api/gift-card-image` | Edge runtime; not invoked under vitest |

## Env vars

`AUTH_SECRET` (customer session, used to mint a cookie for the loyalty route),
`SMTP_*`, `PAYMENT_DRIVER` (read nowhere yet — `getDriver()` is unconditional),
`NODE_ENV` (gates `simulate`), `CRON_SECRET` (staff-code renewal).

No `NEXT_PUBLIC_` variable in this area carries a key, token or secret.

---

# Reconciliation

## 1. Spec without code — `docs/` promises it, nothing implements it

| Gap | Source | Evidence |
|---|---|---|
| **SWC-01** — "Set max uses to 1 on an already-used code, retry → *That code has been fully used*" | REVIEWS-AND-PROMOS.md:305 | True of `promoRefusal`, but the same doc at :159 documents the race that lets two bookings past a cap. There is no hard cap anywhere. The manual step passes; the guarantee a reader takes from it does not hold under concurrency. |
| **SWC-02** — "usable once per month" for a staff code | staff-codes.ts:3, quoting brief §3.3 | Enforced by `max_uses = 1` and counted by `countPromoUse` at confirmation — which means the same staff code survives the same race as SWC-01. |
| **SWC-03** — "expires if unused" | staff-codes.ts:3 | Enforced only by `ends_at` lapsing. Nothing ever sets `active = false` or marks a lapsed code, so `promo_codes` grows one live-looking row per employee per month forever. Behaviour matches the words; the row hygiene the words imply does not exist. |
| **SWC-04** — the gift-card **expiry** | REFILL-AND-GIFT-CARDS.md:137 + the `/gift/[code]` page rendering an expiry | `gift_cards.expires_at` is written and displayed, and `gift_card_status` has an `expired` value — but **nothing reads `expires_at` to refuse a redemption, and nothing ever sets the status to `expired`.** See `known-bugs-rewards.md` BUG-RW-01. |

## 2. Code without spec — the largest list, per the coordinator's correction

Every row here gets a characterization test tagged `// @characterization`.

| Gap | Surface | What is undocumented |
|---|---|---|
| **CWS-01** | `adjustGiftCardBalance` | Neither `status` nor `expires_at` is consulted. A `cancelled` card can still be redeemed against. Nothing in `docs/` says whether that is intended. |
| **CWS-02** | `adjustGiftCardBalance` | A **positive** delta on a card whose status is `redeemed` flips it back to `active`; a positive delta on a `cancelled` card leaves it `cancelled` with a live balance. Undocumented. |
| **CWS-03** | `adjustGiftCardBalance` | Zero delta is `failed` — the same error string as a database failure. A caller cannot tell a validation refusal from an outage. |
| **CWS-04** | `issueGiftCard` | `expiresInMonths: 0` is falsy, so it means "never expires", not "expires immediately". |
| **CWS-05** | `issueGiftCard` | `setMonth` overflow: issuing a 1-month card on 31 January lands on 2 or 3 March, not 28 February. |
| **CWS-06** | `promoDiscount` | A **negative** `value` is possible in the table (`integer`, no CHECK). Floored at 0, so it cannot raise a bill — but nothing documents that the floor is what stops it. |
| **CWS-07** | `promoDiscount` | A `percent` code with `value > 100` is capped by the bill cap, not by a percent cap. `value = 500` behaves exactly as `value = 100`. |
| **CWS-08** | `normalizePromoCode` | Interior whitespace is **not** stripped — `"EID 25"` stays `"EID 25"`. Only leading/trailing whitespace goes. |
| **CWS-09** | `quotePromo` | Comparison is byte-exact after uppercasing, so a Unicode look-alike (`ЕID25` with a Cyrillic Е) is `unknown`, not a match. Undocumented but correct. |
| **CWS-10** | `countPromoUse` | Against a non-existent id it updates zero rows and returns normally. No caller checks. |
| **CWS-11** | `loyaltyBalance` | A ledger row with a null `booking_id` **always counts** — a manual credit no booking can kill. There is no admin surface that writes one, so today the branch is unreachable from the UI. |
| **CWS-12** | `spendPoints` | Takes any `Inserter`. Called with the bare `db` it writes outside a transaction, and nothing stops that. |
| **CWS-13** | `awardPoints` | No idempotency key. Called twice for the same booking it writes two earn rows and the customer is paid twice. The single call site is the only thing preventing it. |
| **CWS-14** | `issueMonthlyCode` | `monthWindow` is UTC, not Riyadh. For the first three hours of a Riyadh month the "current" window is still last month's. |
| **CWS-15** | `issueMonthlyCode` | Concurrency: "already issued" is a read followed by an insert with no lock and no unique key on `(staff_id, starts_at)`. Two callers can both issue. |
| **CWS-16** | `freeCode` | Sanitising is `[^a-zA-Z0-9]`, so an Arabic staff name reduces to nothing and every such member gets `STAFF`, `STAFF2`… — eleven Arabic-named staff exhaust the space. |
| **CWS-17** | `POST /api/gift-cards` | Not throttled and needs no session. `amountSar` is `z.coerce.number()` with no `.int()`, so `50.005` is accepted and `sarToHalalas` rounds it. |
| **CWS-18** | `POST /api/gift-cards` | An **inactive or unknown** `designId` is silently dropped to `null` rather than refused. The buyer pays for a design they do not get. |
| **CWS-19** | `POST /api/gift-cards` | The `payments` row is written **after** the card is issued and is not in the card's transaction. A crash between them leaves a spendable card with no payment record. |
| **CWS-20** | `/gift/[code]` | `expired` and `redeemed` cards render normally; only `cancelled` 404s. |
| **CWS-21** | `/gift/[code]` | The page is `force-dynamic` and unthrottled, so the code space is walkable at whatever rate the host allows. The defence is the 32^16 space alone. |
| **CWS-22** | `GET /api/loyalty/quote` | Signed out answers `200 {balance: 0, signedIn: false}` rather than 401 — deliberately, but nowhere written down. |
| **CWS-23** | `lib/card.ts` | The whole module is undocumented in `docs/`. Its own header is the only spec. |
| **CWS-24** | `lib/giftcard-selection.ts` | Undocumented in `docs/`. |
| **CWS-25** | `cancelCard` | Cancelling leaves `balance_halalas` untouched, so the ledger still sums to a live balance on a dead card. Correct (nothing moved) but it means `status` and `balance` must be read together, which nothing says. |

## 3. Spec contradicts code — **stop and report**

| Contradiction | The two sides |
|---|---|
| **SCC-01 — gift-card expiry** | `REFILL-AND-GIFT-CARDS.md:279` tells the tester to open `/gift/CODE` and read the "expiry", and `gift_card_status` carries an `expired` value, which together read as a promise that an expired card stops working. `lib/giftcards.ts` never reads `expires_at` and nothing ever writes the `expired` status. **Which is authoritative — is `expires_at` decorative, or is redemption meant to refuse an expired card?** Logged as BUG-RW-01; tested as `it.fails`. |
| **SCC-02 — "usable once per month"** | `staff-codes.ts:3` quotes the brief as "usable once per month". `max_uses = 1` makes it usable once **per window**, and the window is a UTC calendar month — but the doc's own `:159` note says a capped code's last use is racy. So "once" is not enforceable as written. **Is the cap meant to be hard for staff codes specifically?** |
| **SCC-03 — who may use a staff code** | `staff-codes.ts:15` says linking a code to an HR record "is explicitly a later phase", implying today's code is shareable by design. Nothing in `docs/` states that a customer may type `SARA` and take 90% off. **Is unrestricted use accepted, or is it an open hole nobody has written down?** No test asserts either way; characterized only. |
