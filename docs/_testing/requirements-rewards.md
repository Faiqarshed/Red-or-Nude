# Requirement register — `rewards`

Phase 1 of `nextjs-drizzle-hardening`, for the area that reduces what a customer
pays: discount codes, the loyalty wallet, gift cards and the per-staff monthly
codes.

Sources are `docs/REVIEWS-AND-PROMOS.md` (the §2.10 half — reviews belong to
another agent), `docs/REFILL-AND-GIFT-CARDS.md` (the §1.2 / §2.7 gift-card half —
refill belongs to another agent), and the two schema comments that are the
authority on the two consistency models (`lib/db/schema.ts:730`, `:743-758`).
Statements taken from a source comment rather than a `docs/` file are marked
`(code comment)` — the skill treats those as spec only where `docs/` is silent,
and every one of them is listed as a documentation gap in
`surface-map-rewards.md`.

Priorities: **P0** money, authorization, anything that can hand out value.

## Discount codes — `PRM`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-PRM-001 | REVIEWS-AND-PROMOS.md:104 | `promoRefusal(rule, total, now)` → `unknown \| inactive \| not-started \| expired \| used-up \| min-total`, or `null` | validation | P0 |
| REQ-PRM-002 | REVIEWS-AND-PROMOS.md:114 | "`promoDiscount` is capped at the total. A 500 SAR fixed code on a 200 SAR bill takes 200." | validation | P0 |
| REQ-PRM-003 | REVIEWS-AND-PROMOS.md:116 | "a promo code must never hand out money that was never taken" | validation | P0 |
| REQ-PRM-004 | REVIEWS-AND-PROMOS.md:110 | "The one exception is `inactive`, which the checkout deliberately reports as 'not valid'" — an outsider must not tell a switched-off code from one that never existed | authz | P0 |
| REQ-PRM-005 | REVIEWS-AND-PROMOS.md:257 | A code typed in lower case applies and echoes back in upper case | validation | P1 |
| REQ-PRM-006 | promo.ts:78 (code comment) | "Codes are stored and compared uppercase"; `normalizePromoCode` trims | validation | P1 |
| REQ-PRM-007 | promo.ts:55 (code comment) | "a code is not both live and expired in the same millisecond" — `startsAt` inclusive, `endsAt` exclusive | state | P0 |
| REQ-PRM-008 | REVIEWS-AND-PROMOS.md:302 | `min_total_halalas` refuses a bill one halala short and admits one exactly on it | validation | P0 |
| REQ-PRM-009 | REVIEWS-AND-PROMOS.md:305 | max uses reached → `used-up` | state | P0 |
| REQ-PRM-010 | REVIEWS-AND-PROMOS.md:154 | A use is counted at payment confirmation, once per bill — never at hold time | side-effect | P0 |
| REQ-PRM-011 | REVIEWS-AND-PROMOS.md:159 | **Known and accepted:** two people racing the *last* use of a capped code can both redeem it | state | P0 |
| REQ-PRM-012 | REVIEWS-AND-PROMOS.md:120 | "The promo comes off **last**, on top of whatever the group or refill discount already took" | state | P0 |
| REQ-PRM-013 | REVIEWS-AND-PROMOS.md:127 | The code is quoted against the **combined** group-discounted bill, then shared back out | state | P0 |
| REQ-PRM-014 | REVIEWS-AND-PROMOS.md:137 | "A refused code **aborts the booking** with `promo-invalid` rather than being ignored" | validation | P0 |
| REQ-PRM-015 | REVIEWS-AND-PROMOS.md:289 | "the two guests' totals sum **exactly** to the bill" — not within a halala | validation | P0 |
| REQ-PRM-016 | REVIEWS-AND-PROMOS.md:180 | Codes are switched off, never deleted | state | P2 |
| REQ-PRM-017 | REVIEWS-AND-PROMOS.md:182 | Editing a live code changes future bookings only; `bookings.discount_halalas` is frozen | state | P1 |
| REQ-PRM-018 | schema.ts:806 | `promo_codes.code` is unique | validation | P1 |
| REQ-PRM-019 | promo/quote/route.ts:11 (code comment) | The quote endpoint "decides nothing" — `POST /api/bookings` re-looks-up and re-prices; the browser's total is not trusted | authz | P0 |
| REQ-PRM-020 | promo/quote/route.ts:17 (code comment) | The quote endpoint is throttled, because it distinguishes `unknown` from `expired` and so enumerates unreleased campaign codes | authz | P0 |
| REQ-PRM-021 | promo/quote/route.ts:45 | A refusal answers `200` with a reason, not a 4xx | contract | P2 |

## Loyalty wallet — `LOY`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-LOY-001 | schema.ts:745 | The loyalty ledger is deliberately **without** a running-balance column; the balance is a filtered SUM | state | P0 |
| REQ-LOY-002 | schema.ts:752 | The balance query ignores rows whose booking is cancelled | state | P0 |
| REQ-LOY-003 | schema.ts:752 | …a no-show | state | P0 |
| REQ-LOY-004 | schema.ts:752 | …or a hold that has sat unpaid past its window | state | P0 |
| REQ-LOY-005 | schema.ts:755 | "a cancellation, an abandoned checkout and a declined payment each return the points with no compensating write anywhere" | state | P0 |
| REQ-LOY-006 | schema.ts:757 | "cancelling a paid booking revokes what it earned by the same rule" | state | P0 |
| REQ-LOY-007 | schema.ts:758 | "If a new case appears, widen the filter — do not add a refund path" — there is no compensating-write path | state | P1 |
| REQ-LOY-008 | rewards.ts:118 (code comment) | A rung is refused when the balance cannot reach it (`locked`) or no rung costs that many points (`unknown`) | validation | P0 |
| REQ-LOY-009 | rewards.ts:73 (code comment) | A reward discount is capped at the bill | validation | P0 |
| REQ-LOY-010 | loyalty.ts:80 (code comment) | Points are spent inside the booking transaction, where the customer row is already locked — that lock is what stops two tabs spending the same balance twice | state | P0 |
| REQ-LOY-011 | loyalty.ts:95 (code comment) | Points are awarded once per bill at confirmation, never at hold time | side-effect | P0 |
| REQ-LOY-012 | loyalty/quote/route.ts:11 (code comment) | "The customer is resolved from the session cookie and **never from the body**" | authz | P0 |
| REQ-LOY-013 | loyalty/quote/route.ts:49 | Signed out → `401` | authz | P0 |
| REQ-LOY-014 | loyalty.ts:107 (code comment) | `awardPoints` swallows its own errors — a missed award must never fail a paid booking | side-effect | P1 |
| REQ-LOY-015 | REVIEWS-AND-PROMOS.md:120 + bookings.ts:727 | The reward comes off **last of all** — after group/refill, after the promo | state | P0 |
| REQ-LOY-016 | bookings.ts:744 | A refused rung aborts the booking with `reward-invalid` rather than being ignored | validation | P0 |
| REQ-LOY-017 | bookings.ts:98 (code comment) | `customerId` is "trusted, and therefore never read from a request body" | authz | P0 |
| REQ-LOY-018 | bookings.ts:105 (code comment) | `redeemPoints` is ignored entirely without a `customerId` | authz | P0 |

## Gift cards — `GFT` / `GTX`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-GFT-001 | schema.ts:730 | "Balance is the running sum; **never edit balance without a row here**" | state | P0 |
| REQ-GFT-002 | giftcards.ts:5 (code comment) | "a balance can always be re-derived from the ledger, and a drift is a detectable bug" | state | P0 |
| REQ-GFT-003 | giftcards.ts:117 (code comment) | "Refuses to go below zero — a card must never fund more than it holds" | validation | P0 |
| REQ-GFT-004 | giftcards.ts:124 (code comment) | The card row is `SELECT … FOR UPDATE`-locked so two concurrent redemptions cannot both read the same balance | state | P0 |
| REQ-GFT-005 | giftcards.ts:43 | An amount that is not a positive integer is refused `invalid-amount` | validation | P0 |
| REQ-GFT-006 | giftcards.ts:110 | A zero or non-integer delta is refused | validation | P0 |
| REQ-GFT-007 | giftcards.ts:134 | A card reaching a zero balance becomes `redeemed`; one funded back up returns to `active` | state | P1 |
| REQ-GFT-008 | giftcards.ts:16 (code comment) | Codes carry no I/O/0/1 — they are typed off a printed card and read over the phone | validation | P2 |
| REQ-GFT-009 | schema.ts:726 | `gift_cards.code` is unique | validation | P0 |
| REQ-GFT-010 | glossary.md (Ownership chains) | "Gift card: `gift_cards.code → balance`. Bearer instrument — possession of the code is the authorization." | authz | P0 |
| REQ-GFT-011 | gift/[code]/page.tsx:3 (code comment) | "sixteen characters from a 32-character alphabet, so it is not something anyone stumbles onto" | authz | P0 |
| REQ-GFT-012 | gift/[code]/page.tsx:41 | "A cancelled card is not shown at all — as far as the recipient is concerned it was never issued" | authz | P0 |
| REQ-GFT-013 | REFILL-AND-GIFT-CARDS.md:116 | "Order matters: **charge first, issue second**" | side-effect | P0 |
| REQ-GFT-014 | REFILL-AND-GIFT-CARDS.md:293 | A declined charge leaves **no new row in `gift_cards`** | side-effect | P0 |
| REQ-GFT-015 | REFILL-AND-GIFT-CARDS.md:114 | The purchase writes a `payments` row carrying `gift_card_id` | side-effect | P1 |
| REQ-GFT-016 | REFILL-AND-GIFT-CARDS.md:137 | The custom amount is bounded 50–2000 SAR | validation | P0 |
| REQ-GFT-017 | REFILL-AND-GIFT-CARDS.md:296 | No recipient at all → `400 no-recipient`; `amountSar: 10` → `400` | validation | P0 |
| REQ-GFT-018 | gift-cards/route.ts:76 (code comment) | "Only offer designs the salon has actually published" — an inactive design id is dropped, not honoured | validation | P1 |
| REQ-GFT-019 | REVIEWS-AND-PROMOS.md:198 | **Gift-card redemption at checkout was deliberately not built.** A gift card is a separate balance ledger; it does not enter a booking's price. | state | P0 |
| REQ-GFT-020 | gift-card-image/route.tsx:31 (code comment) | The card image amount is bounded the same way the purchase is, so it cannot render a card claiming an arbitrary amount | validation | P2 |
| REQ-GFT-021 | gift-card-image/route.tsx:19 (code comment) | The code is deliberately **not** drawn into the image — Gmail proxies remote images | authz | P1 |
| REQ-GFT-022 | gift-cards/actions.ts:31 | Issuing needs `giftcards.issue`; adjusting a balance needs the higher `giftcards.adjust` | authz | P0 |

## Staff monthly codes — `PRM` (`staff_id` set)

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-STC-001 | staff-codes.ts:3 (code comment, quoting brief §3.3) | "Each employee gets a unique code (e.g. 'Sara'), around 90% discount, usable once per month, auto-renews each month, expires if unused." | state | P0 |
| REQ-STC-002 | staff-codes.ts:9 (code comment) | Every one of those rules is enforced by the promo engine — a staff code **is** a promo code, so it obeys every ordinary promo rule | state | P0 |
| REQ-STC-003 | staff-codes.ts:22 | The discount is `STAFF_CODE_PERCENT = 90` percent | validation | P1 |
| REQ-STC-004 | staff-codes.ts:25 | `monthWindow(date)` is the first instant of that UTC month to the first instant of the next | validation | P0 |
| REQ-STC-005 | staff-codes.ts:64 (code comment) | Issuing is idempotent inside the window — a member who already has one gets nothing new | side-effect | P0 |
| REQ-STC-006 | staff-codes.ts:34 (code comment) | A name collision falls through `SARA`, `SARA2`… to `SARA10`, then refuses `no-free-code` | validation | P1 |
| REQ-STC-007 | staff-codes.ts:113 (code comment) | Nothing deletes last month's code — an unused code simply lapses when its window closes | state | P1 |
| REQ-STC-008 | staff-codes.ts:118 | The monthly renewal issues to **active** staff only | side-effect | P1 |
| REQ-STC-009 | staff-codes.ts:15 (code comment) | **Explicitly not built:** nothing links a code to an HR record, so nothing stops a staff code being shared | authz | P0 |

## Ambiguous / contradictory — answer needed before these are tested as spec

| REQ | Question |
|---|---|
| REQ-PRM-A01 | `REVIEWS-AND-PROMOS.md:305` tells the tester to "set max uses to 1 on an already-used code" and expect refusal, while `:159` documents the race that lets two bookings past a cap. Both are true of the current code (the cap is checked at hold, counted at confirmation) — but the doc never says what the *intended* end state is. Tested as **characterization**, not as spec. |
| REQ-PRM-A02 | Nothing in `docs/` states whether a promo code may be applied by the customer whose `staff_id` it carries, or by any other customer. `staff-codes.ts:15` says the link to an HR record is "a later phase", which implies unrestricted use is current-and-known, not a bug. Logged as an open question, tested as characterization. |
| REQ-GFT-A01 | `docs/` never states whether a **cancelled** or **expired** gift card may still be adjusted. `adjustGiftCardBalance` checks neither. Tested as characterization and raised in `known-bugs-rewards.md`. |

---

## Code-first enumeration — every export in the area

Added after the coordinator's correction: the source is a first-class
specification. Below is every exported symbol in the area's `lib/` files, the
branches inside it, and the requirement each branch carries. Rows whose source
is a comment are cited `file:line` exactly as a `docs/` line is. Rows with **no**
source beyond the code itself are characterization targets (Phase 4) and are
listed again under "code without spec" in `surface-map-rewards.md`.

### `lib/promo.ts`

| REQ | Export / branch | Source | Statement | Pri |
|---|---|---|---|---|
| REQ-PRM-030 | `promoRefusal` refusal order | promo.ts:52-59 | The checks run `active -> not-started -> expired -> used-up -> min-total`; the first failing one is the answer, so a code that is both off and expired reads `inactive` | P0 |
| REQ-PRM-031 | `promoRefusal` null window | promo.ts:53-56 | A null `startsAt` or `endsAt` means that side of the window is open | P1 |
| REQ-PRM-032 | `promoRefusal` null `maxUses` | promo.ts:57 | A null `maxUses` is uncapped, whatever `uses` reads | P1 |
| REQ-PRM-033 | `promoDiscount` non-positive bill | promo.ts:70 | A bill of zero or less discounts zero — before any percent maths runs | P0 |
| REQ-PRM-034 | `promoDiscount` percent rounding | promo.ts:73 | Percent is `Math.round(total x value / 100)` — one rounding, half-up, to the halala | P0 |
| REQ-PRM-035 | `promoDiscount` negative `value` | *(no source — characterization)* | A negative `value` on a fixed code is floored at 0 by `Math.max`, so it cannot *increase* a bill | P0 |
| REQ-PRM-036 | `normalizePromoCode` | promo.ts:79-81 | `trim()` then `toUpperCase()` — nothing else; interior whitespace survives | P1 |
| REQ-PRM-037 | `quotePromo` empty after normalize | promo.ts:102 | A code that normalizes to the empty string is `unknown` without a database round trip | P1 |
| REQ-PRM-038 | `quotePromo` lookup | promo.ts:105-109 | The lookup is `eq(code, normalized)` — a parameterized equality, never a `LIKE` and never string-interpolated | P0 |
| REQ-PRM-039 | `quotePromo` min-total detail | promo.ts:114-117 | Only the `min-total` refusal carries `minTotalHalalas` back; every other refusal carries nothing extra | P1 |
| REQ-PRM-040 | `countPromoUse` | promo.ts:143-146 | The increment is `uses = uses + 1` **in SQL**, not read-then-write, so two confirmations landing at once cannot both write the same value | P0 |
| REQ-PRM-041 | `countPromoUse` swallowed error | promo.ts:147-151 | It swallows its own errors: "a miscounted redemption is a reporting problem, not a reason to fail a paid booking" | P1 |
| REQ-PRM-042 | `countPromoUse` unknown id | *(no source — characterization)* | Counting a use against an id that does not exist updates nothing and does not throw | P2 |

### `lib/rewards.ts`

| REQ | Export / branch | Source | Statement | Pri |
|---|---|---|---|---|
| REQ-LOY-030 | `REWARDS` | rewards.ts:24 | "**Linear on purpose: every 100 points is another 5% off.**" Value per point must never fall as the rungs rise | P1 |
| REQ-LOY-031 | `rewardFor` | rewards.ts:42 | Matches a rung by **exact** point cost — 250 is not "the 200 rung" | P0 |
| REQ-LOY-032 | `pointsEarned` floor | rewards.ts:88 | "**Floored, never rounded.**" Rounding up lets a customer mint a point by splitting a bill | P0 |
| REQ-LOY-033 | `pointsEarned` guards | rewards.ts:99 | A non-positive total or a non-positive divisor earns zero — and never divides by zero | P0 |
| REQ-LOY-034 | `pointsEarned` argument | rewards.ts:94 | It is called with what the customer **paid**, not the pre-discount bill — "earning on the pre-discount figure would make a discount partly pay for itself" | P0 |
| REQ-LOY-035 | `isDead` null status | rewards.ts:138 | A movement attached to no booking always counts | P0 |
| REQ-LOY-036 | `isDead` null `createdAt` | rewards.ts:145 | A pending booking with no `created_at` is treated as **dead**, deliberately: "the failure mode of guessing wrong is a customer who cannot spend points they own, and that is the worse of the two" | P1 |
| REQ-LOY-037 | `isDead` window boundary | rewards.ts:146 | The hold is dead **strictly after** `holdMin` minutes — exactly on the boundary it is still live | P0 |
| REQ-LOY-038 | `spendableBalance` | rewards.ts:155 | "**This is the whole rule, and the only copy of it**" — there is no SQL version to drift | P0 |

### `lib/loyalty.ts`

| REQ | Export / branch | Source | Statement | Pri |
|---|---|---|---|---|
| REQ-LOY-040 | `loyaltyBalance` join | loyalty.ts:37-42 | A **left** join, so a ledger row whose `booking_id` is null still reaches `spendableBalance` with a null status rather than being dropped | P0 |
| REQ-LOY-041 | `loyaltyBalance` scope | loyalty.ts:42 | Filtered by `customerId` — one customer's ledger and no one else's | P0 |
| REQ-LOY-042 | `loyaltyBalance` hold window | loyalty.ts:32 | The window comes from `settings.booking_hold_min`, read per call, not a constant | P1 |
| REQ-LOY-043 | `quoteReward` re-reads | loyalty.ts:65 | The balance is re-read inside the quote; the caller cannot supply one | P0 |
| REQ-LOY-044 | `spendPoints` non-positive | loyalty.ts:92 | Zero or negative points insert **nothing** — a redemption cannot be turned into a credit | P0 |
| REQ-LOY-045 | `spendPoints` sign | loyalty.ts:95 | The row is written `-points` with reason `reward` | P0 |
| REQ-LOY-046 | `spendPoints` handle | loyalty.ts:83 | Takes an `Inserter` — the db **or a transaction handle** — so the write joins the booking's transaction and rolls back with it | P0 |
| REQ-LOY-047 | `awardPoints` non-positive | loyalty.ts:113 | Zero or negative points award nothing | P0 |
| REQ-LOY-048 | `awardPoints` sign | loyalty.ts:116 | The row is written `+points` with reason `earned` | P1 |

### `lib/staff-codes.ts`

| REQ | Export / branch | Source | Statement | Pri |
|---|---|---|---|---|
| REQ-STC-020 | `monthWindow` UTC | staff-codes.ts:26-27 | Built from `Date.UTC` — the window is a **UTC** month, not a Riyadh one | P0 |
| REQ-STC-021 | `monthWindow` December | staff-codes.ts:27 | Month 11 + 1 rolls to January of the next year | P1 |
| REQ-STC-022 | `freeCode` sanitising | staff-codes.ts:35 | Non-alphanumerics are stripped; a name that leaves nothing falls back to `STAFF` | P1 |
| REQ-STC-023 | `freeCode` candidates | staff-codes.ts:36 | Ten candidates: the bare root then `2`...`10` | P1 |
| REQ-STC-024 | `issueMonthlyCode` unknown staff | staff-codes.ts:71 | An id with no staff row is `not-found` — checked before anything is written | P1 |
| REQ-STC-025 | `issueMonthlyCode` existing test | staff-codes.ts:73-84 | "Already issued" is decided by `staff_id` **and** a `starts_at` inside the window — last month's code does not block this month's | P0 |
| REQ-STC-026 | `issueMonthlyCode` shape | staff-codes.ts:98-107 | The row is written `type=percent`, `value=90`, `maxUses=1`, `startsAt=window.start`, `endsAt=window.end`, `active=true` | P0 |
| REQ-STC-027 | `issueMonthlyCode` first name | staff-codes.ts:96 | The code is built from the **first** whitespace-separated word of the name | P2 |
| REQ-STC-028 | `issueMonthlyCodesForEveryone` | staff-codes.ts:118-128 | Counts `issued` and `skipped`; every non-`ok` outcome is a skip, whatever the reason | P1 |

### `lib/giftcards.ts`

| REQ | Export / branch | Source | Statement | Pri |
|---|---|---|---|---|
| REQ-GFT-030 | `makeGiftCardCode` shape | giftcards.ts:24 | `XXXX-XXXX-XXXX-XXXX` — sixteen characters from a 32-symbol alphabet in four dash-separated groups | P0 |
| REQ-GFT-031 | `makeGiftCardCode` entropy | giftcards.ts:21 | Every character comes from `crypto.randomInt`, never `Math.random` | P0 |
| REQ-GFT-032 | `issueGiftCard` amount guard | giftcards.ts:45-47 | Non-integer, zero or negative -> `invalid-amount`, before any write | P0 |
| REQ-GFT-033 | `issueGiftCard` expiry | giftcards.ts:50-54 | `expiresInMonths` is added to the issue date with `setMonth`; falsy (including `0`) leaves the card open-ended | P1 |
| REQ-GFT-034 | `issueGiftCard` opening entry | giftcards.ts:80-85 | "The opening balance is a ledger entry like any other" — written inside the same transaction as the card | P0 |
| REQ-GFT-035 | `issueGiftCard` collision retry | giftcards.ts:57-59 | A `gift_cards_code_unique` violation retries with a fresh code, up to five times, rather than surfacing a constraint error to a paying customer | P1 |
| REQ-GFT-036 | `issueGiftCard` other errors | giftcards.ts:94-96 | Any other error returns `failed` and does **not** retry | P1 |
| REQ-GFT-037 | `adjustGiftCardBalance` delta guard | giftcards.ts:117-119 | A non-integer or **zero** delta is refused `failed` before the transaction opens | P0 |
| REQ-GFT-038 | `adjustGiftCardBalance` missing card | giftcards.ts:131 | An unknown id is `not-found` | P1 |
| REQ-GFT-039 | `adjustGiftCardBalance` overdraw | giftcards.ts:134 | `balance + delta < 0` -> `insufficient`, and **nothing is written** | P0 |
| REQ-GFT-040 | `adjustGiftCardBalance` status | giftcards.ts:140 | Zero balance -> `redeemed`; a previously `redeemed` card being funded -> `active`; every other status is left alone | P1 |
| REQ-GFT-041 | `adjustGiftCardBalance` expiry/cancel | *(no source — characterization; see REQ-GFT-A01)* | Neither `expires_at` nor `status = cancelled/expired` is consulted | P0 |
| REQ-GFT-042 | `ledgerBalance` | giftcards.ts:161 | "used to prove the cached balance hasn't drifted" — `coalesce(sum(delta), 0)`, so a card with no ledger reads 0 | P0 |

### `lib/card.ts` — checkout card-field rules

| REQ | Export / branch | Source | Statement | Pri |
|---|---|---|---|---|
| REQ-CRD-001 | file header | card.ts:9 | "These are *input* boundaries, not authorisation. Nothing here proves a card is real or has funds" | P0 |
| REQ-CRD-002 | file header | card.ts:12 | The fields are display-only — "nothing is posted to our server, and it must stay that way" (PCI scope) | P0 |
| REQ-CRD-003 | `brandOf` | card.ts:27-33 | Visa `4`, Amex `34`/`37`, Mastercard `51-55` and `2221-2720`; anything else `unknown` | P1 |
| REQ-CRD-004 | `cvvLength` | card.ts:36 | Amex takes 4, everyone else 3 | P1 |
| REQ-CRD-005 | `formatCardNumber` | card.ts:43 | Amex groups 4-6-5; everyone else 4-4-4-4-3, truncated at `CARD_NUMBER_MAX` | P2 |
| REQ-CRD-006 | `luhnValid` | card.ts:57 | The Luhn checksum, refusing anything under 12 digits outright | P1 |
| REQ-CRD-007 | `validateCardNumber` | card.ts:91 | 13 through 19 digits, then the checksum | P1 |
| REQ-CRD-008 | `validateExpiry` | card.ts:115 | "A card is good through the last day of its printed month" — compare months, not days | P0 |
| REQ-CRD-009 | `validateExpiry` far future | card.ts:121 | More than 20 years out is a mistyped year, not a valid card | P2 |
| REQ-CRD-010 | `validateCard` | card.ts:145 | An empty error object means the form may be submitted | P1 |

### `lib/giftcard-selection.ts` — browser-only

| REQ | Export / branch | Source | Statement | Pri |
|---|---|---|---|---|
| REQ-GSL-001 | all three exports | giftcard-selection.ts:23,28,38 | Every function is a no-op (or `null`) when `window` is undefined, so a server render never touches `sessionStorage` | P1 |
| REQ-GSL-002 | `loadGiftSelection` | giftcard-selection.ts:30-34 | Malformed stored JSON returns `null` rather than throwing | P1 |
| REQ-GSL-003 | file header | giftcard-selection.ts:2 | The selection lives only until the purchase is confirmed — "at which point the card itself becomes the record" | P2 |

### `lib/giftcard/email.ts`

| REQ | Export / branch | Source | Statement | Pri |
|---|---|---|---|---|
| REQ-GEM-001 | `sendGiftCardEmails` | giftcard/email.ts:191 | "Never throws: the buyer has already been charged and the card already exists" | P0 |
| REQ-GEM-002 | `sendGiftCardEmails` buyer copy | giftcard/email.ts:228 | The buyer's copy is sent **only if the address differs** from the recipient's | P1 |
| REQ-GEM-003 | `sendGiftCardEmails` no addresses | giftcard/email.ts:198 | With neither address the outcome is `skipped`/`skipped` and nothing is sent | P1 |
| REQ-GEM-004 | `renderGiftCardEmail` | giftcard/email.ts:78 | Renders in `ar` and `en`; both halves must exist (glossary, Locales) | P1 |
| REQ-GEM-005 | `renderGiftCardEmail` escaping | giftcard/email.ts (uses `esc`) | The buyer's free-text message is HTML-escaped — it is attacker-controlled text landing in someone else's inbox | P0 |
