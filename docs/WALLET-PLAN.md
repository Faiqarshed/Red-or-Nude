# Wallet plan

## Context
Once a booking is confirmed, money never goes back to the card. It becomes **wallet credit** (decided in PAYMENT-HARDENING-PLAN.md, "Refund rule"). Gift cards also become wallet credit. Today:
- no money wallet exists (the /account "wallet" holds loyalty points);
- her own cancel refunded the card (`refundBookings`, now removed);
- a salon cancel moves no money;
- nothing can spend a gift card: `adjustGiftCardBalance` is called only by the admin adjust action.

Goal: one wallet per customer. It is filled by cancellations, gift cards and small chair refunds, and spent at every checkout, buying gift cards included. A guest's credit belongs to her **email**, and waits until she signs in with it.

Fixed decisions:
- **Spent at:** bookings (with their chair add-ons), memberships, chair QR purchases, and buying gift cards (the client, 2026-09-30).
- **Never expires (confirmed by the client).** An unclaimed gift card keeps its own `expiresAt`. Once claimed into the wallet, the credit never expires.
- **Walk-ins are retired.** Every booking comes through the online app, with an email. The desk's walk-in flow (`WalkInDrawer`) is hidden. Old walk-in records (a phone, no email) are joined by her first online booking with that phone.
- **A guest is her email.** Every credit is tagged with the email of the booking or card it came from, and only a sign-in with that email reaches it.
- **A gift card is locked to its recipient's email.** At checkout the code works only together with that email, and anything left over is tagged to it. Someone who sees the code alone can't use it or lock it. A card the desk issued with no email is the code alone.
- **Only the booker cancels, and nobody refunds from StreamPay's dashboard.** Both are policy. The code still handles a dashboard refund or a chargeback safely (`reverseCredit`), because a rule is not a lock and a bank can reverse a payment whatever we decide.
- **Every change is a row.** Spends, releases, reversals and corrections are all written to the ledger, so "why did my balance change?" is answered from the table alone.
- **She never sees a negative balance.** Shown and spendable: `max(0, sum)`. Only a customer who paid and then got that money back can owe the wallet; the debt is kept in the table and paid off by her next credits first. A gift card's recipient never owes anything for the buyer's payment.
- **Only the owner corrects, with a reason.** No staff action writes to the ledger. The owner can add a `correction` row from the "Needs your decision" page, with a required reason, recorded in the audit log.
- **Always on, no launch switch** (the owner, 2026-10-01). Production starts on an empty database (Azure), so there is no live site to move over: no old bookings without an email, no old gift cards, no old chair refunds. The before-the-wallet behaviour (card refund on cancel, tax-free gift cards, `wallet_launched_at`) was deleted rather than kept behind a switch someone could forget to set.
- **Credit is VAT-inclusive at face value** (the owner): a 100 SAR gift card is 100 SAR of credit; a cancelled 115 SAR booking is 115 SAR. Every price is shown with VAT, as Saudi rules require, and VAT is never taken off a credit.
- **Gift card email:** the brand card image goes inline (cid attachment), so it shows without "load images".

## Open questions
**For the client (to send): our assumption, not decided.**
0. ~~A group dropping guests~~: answered, see Settled.

**For the client (sent, waiting):**
1. ~~Salon cancel inside 3 h~~: answered, see Settled.
2. ~~VAT~~: the owner's decision, see Settled.
3. **One sentence for the refund policy.** Card refunds still happen when she pays late, pays the wrong amount, pays twice, or buys something we can't deliver. Proposed: "A payment that bought nothing goes back to the card; everything else goes to the wallet." Written into PAYMENTS-STATUS.md once agreed.
4. ~~Invoice wording~~: answered, see Settled.

**For us, before step 2:**
6. **Bookings made before step 1 have no `customer_email`.** Their cancel credit has no email to belong to. Either take the customer row's email (the unreliable one, gap 3) or send each to "Needs your decision". Decide before step 2 writes cancel credit.

**For StreamPay support:**
5. What status does a chargeback show on a payment: `REFUNDED`, or something like `DISPUTED`? Is there a disputes API or webhook? Today there is no chargeback event (`app/api/payments/streampay/webhook/route.ts`), and the daily comparison is what finds one.

**Settled:**
- **A group cancels as one** (the client, 2026-09-30), by the booker, never guest by guest. One payment, one credit, of what was paid after the 10% group discount. `creditCancelled` already credits what was paid.
- **Invoice wording** (the client, 2026-09-30): "Wallet credit" and "Gift card" as discount lines on StreamPay's tax invoice, as promo codes are. Built: a guest's gift card is "Gift card" on her StreamPay bill and her booking email (`paidWithGiftCard`, `lib/wallet.ts`: her spend is tagged with the card); signed in, the card went into her wallet first, so it is "Wallet credit".
- **VAT** (the owner, 2026-09-30 and 2026-10-01): every price VAT-inclusive, as Saudi rules require; customers only ever see the inclusive price.
  - gift cards are taxed when sold: a "100 SAR" card costs 100 SAR including VAT, like every price here, and brings 100 SAR of credit. Spending one later as a discount is then right, since the tax was collected at sale;
  - a cancelled booking gets no credit note and keeps its VAT; her credit is a discount on the next bill (option A);
  - buying a gift card with credit is allowed (the client), on the same footing.
- **The salon never cancels a booking** (the client, 2026-09-30), inside 3 h or not. Only she cancels. Switched off by `SALON_CAN_CANCEL = false` (`lib/cancellation.ts`), not deleted: the desk's cancel stays built and tested, for the day the client wants it back (a technician off sick). Switching it back on reopens the 3 h question with the client.
- Credit never expires (the client).
- StreamPay's payment page has no field for typing a coupon (checked in the sandbox). If one appears, a payment below our amount is already refunded and nothing is given for it (`confirm.ts` "wrong-amount", `purchase.ts` "wrong-amount").


## How money enters and leaves

| Event | Wallet |
|---|---|
| She cancels more than 3 h before | **+** card paid on that booking + wallet spent on it |
| Salon cancels | Never (the client, 2026-09-30): refused, and no cancel button. Switched back on (`SALON_CAN_CANCEL`), **+** same amount, reason required |
| She cancels within 3 h | Not allowed (already enforced) |
| A cancelled booking with a cancel credit set back to confirmed | Refused. The desk makes a new booking |
| No-show (`resolveNoShow`, marked no-show) | Nothing. Her points on it stand: what it earned counts, what it spent stays spent |
| Gift card bought for an email that has an account | **+** full card value on delivery. The card becomes `redeemed` |
| Gift card code + its recipient email entered at checkout | **+** the card's whole balance, tagged to the recipient email, then spent on the bill. Anything left stays in that email's wallet. A card issued with no email needs the code alone, and its leftover goes to the email she books with |
| Gift card's email signs up later | **+** every active card sent to that email is claimed at `createAccount` |
| Chair purchase of 10 SAR or less we couldn't deliver | **+** amount (turns `owedCredit` into credit) |
| Her own payment behind a cancel or chair credit is refunded outside the app or charged back | **−** what went back to her card, less what was already taken back, never more than the credit that payment gave. May go below 0: shown as 0, owner alerted |
| The payment that bought a claimed gift card is refunded or charged back | **−** only what is still in the recipient's wallet, never below 0. The rest is the salon's loss, on the owner's page |
| Checkout uses credit | **−** min(available, bill), kept so at least 1 SAR is left to charge or the bill is fully covered |
| Checkout abandoned, declined, or hold lapsed | **+** a `release` row for that spend |
| A released checkout's payment turns up paid (revive) | **−** a re-spend of that release if the balance still covers it. Otherwise nothing is delivered, and the card part is refunded as a late payment |
| Owner correction | **±** with a reason, audited |

Examples:
- Card 100, bill 500: 100 off, 400 charged.
- Card 250, bill 250: nothing charged, booking confirmed on the zero-bill path.
- Card 500, bill 250: free, and 250 left in the wallet. A guest gets an email: "250 SAR is in your Red or Nude wallet. Sign in with <email> to use it."

## Gaps found in the code (and how each is closed)
1. **No way to spend a gift card.** Closed by the claim-into-wallet step at checkout. `adjustGiftCardBalance` (`lib/giftcards.ts:124`) doesn't check `status` or `expiresAt`, so the claim checks both.
2. **No cancellation email exists.** `notifyCustomer("booking-cancelled")` only logs to the console (`lib/notify/log.ts`). **Built (step 2d):** both cancels send `sendCancelCreditEmail` (`lib/wallet-email.ts`): the amount, her balance, the salon's reason when it cancelled, and for a guest the email to sign in with. It carries no tax document (StreamPay's invoice is the only one).
3. **A guest row is one per phone, and its email is overwritten.** Each guest booking overwrites the row's email (`createBookings`, `lib/bookings.ts:1155-1187`), and bookings save no email of their own. Two people sharing a phone share a row, so credit tagged from the row's email can name the wrong person, and `createAccount` turns the whole row into whoever signs up. Walk-ins may have no email at all (`WalkInDrawer.tsx` sends one only if typed). Closed:
   - walk-ins are retired (the desk flow hidden), so every new booking has an email, and a guest is found by it;
   - an old walk-in record (a phone, no email) is not left behind: an online booking whose email has no guest record yet, but whose phone matches one with no email, gives that record the email instead of making a new one, so her walk-in visits and points join her. The risk (a sister's walk-in history on her record) touches visits and points only, never wallet money: walk-ins paid at the desk;
   - `bookings.customer_email` is saved at booking time; every credit's `owner_email` comes from the booking (or the gift card), never from the customer row;
   - the balance counts only rows whose `owner_email` is the account's verified email.
4. **A no-show also ends at `cancelled`** (`resolveNoShow`, `bookings/actions.ts:283`). Credit is never derived from the status. Only the two cancel paths write it.
5. **`bookings.customerId` can be null** (walk-in, deleted customer). Walk-ins have no payment, so the amount is 0. Money on a customer-less booking goes to the "Needs your decision" page instead of crediting.
6. **Purchases have no zero-bill path.** `startPurchase` always calls StreamPay. A zero path like `confirmBookingPayment`'s (`lib/payments/confirm.ts:217`) is added.
7. **`refundPaid` refuses a 0 total** (`refund.ts:101`). An undelivered purchase paid fully by credit is marked `refunded` without StreamPay, and its spend gets a `release` row.
8. **A guest mistypes her booking email.** Cancel credit on `sara@gmial.com` can never be reached. Before a guest's cancel credit is written, the email is shown back ("Your credit will be saved to s***@gmial.com. Is this right?"), and common domain typos (gmial, hotmial, yaho) are flagged. If it still goes wrong, staff check the booking's phone against her claim and the owner moves the credit with a `correction`. Gift card credit can't hit this: it is tagged to the card's own recipient email.
9. **StreamPay minimum:** a link under 1 SAR after coupons is untested (PAYMENTS-STATUS ~L422). Credit is capped so at least 1 SAR remains, unless it covers the whole bill.
10. **The gift card image is a remote URL and always brand red.** It is attached inline instead. The chosen design stays unsupported (INVOICE-EMAIL.md §8).
11. **The salon cancel is two separate writes.** `setBookingStatus` (`bookings/actions.ts:103-140`) saves the status with no transaction and no check of the previous status, then returns pack credits in a try/catch that only logs. A crash between them leaves a cancelled booking with no credit. Closed in Cancellation below.
12. **Purchases take no customer lock.** `startPurchase` (`purchase.ts:88`) has no transaction, so two tabs could spend one balance twice. Closed by `spendWallet` below.
13. **A chargeback reverses nothing.** Chargebacks reach us only through the daily comparison (`reconcile.ts` `compareWithGateway`, 120 days back), which calls `refundedOutside` like the refund webhook does. `refundedOutside` only freezes gift cards. Closed by `reverseCredit` below.
14. **A gift card code alone is enough to use it.** The buyer sees the code on the success screen and shares it (WhatsApp); anyone holding it could claim the card into their own wallet, even by starting a checkout and abandoning it. Closed by the recipient-email lock. `recipientEmail` (and `buyerEmail`) are optional today (`app/api/gift-cards/route.ts:35`, `purchase.ts:37-39`): the recipient's becomes required on the form. A card the desk issues with no email has no lock and works with the code alone.
15. **A group cancels only as a unit** (`app/api/my-bookings/cancel/route.ts:75`), because the 10% exists only while 2 or more book together. Kept as the rule (the client, 2026-09-30): no dropping guests.

## Design

### Data (migration 0031)
- `wallet_txns`: `id`, `customer_id` (fk customers), `owner_email` (lowercased, **every row**), `delta_halalas` int (non-zero), `reason` (`cancel-customer | cancel-salon | gift-card | chair-credit | spend | release | reversal | correction`), `booking_id`, `payment_id`, `gift_card_id`, `reverses_id` (fk wallet_txns: the row a `release`, re-spend or `reversal` answers), `note` (required on `correction` and `cancel-salon`), `actor_id`, `created_at`.
  - Partial unique indexes make every write idempotent, following the `pack_txns_return_unique` pattern (`schema.ts:1050`):
    - one cancel credit per booking;
    - one **first** spend per booking, and one per purchase payment (`reason = 'spend' and reverses_id is null`);
    - one `release` per spend, and one re-spend per release (`reason in ('release','spend')`, unique on `reverses_id`);
    - one claim per gift card;
    - one chair credit per payment.
  - Reversals have **no** unique index: a payment can be refunded in several parts. `reverseCredit` makes them safe to repeat instead (below). A reversal carries the `payment_id` it answers.
- `wallet_decisions`: `id`, `kind`, `customer_id`, `booking_id`, `payment_id`, `amount_halalas`, `detail`, `resolved_at`, `resolved_by`, `resolution_note`, `created_at`. Every case sent to the owner is written here **from step 1**, before the page that shows it exists.
- `bookings.customer_email` text, saved at booking time.
- `bookings.wallet_discount_halalas` int default 0, stored per member row like `points_discount_halalas`.
- Guest identity:
  - `customers_guest_email_unique` on `lower(email)` where not verified **and email is not null**;
  - `customers_guest_phone_unique` narrowed to guest rows **with no email** (old walk-in records; no new ones are made);
  - `createBookings`, with her email: the guest record with that email; else an email-less record with her phone, which takes the email; else a new record. The migration first merges guest rows that already share an email, the way `createAccount` merges them. No wallet rows exist yet, so no money moves.
- Card claim: set the card to `redeemed` with balance 0, and add a `gift_card_txns` row (`reason: "to-wallet"`). No new gift card column: the lock email is `recipientEmail`; a card with none is the code alone.

### `lib/wallet.ts` (one file)
- `walletBalance(ownerEmail, executor?)`: SUM(delta) over every row whose `owner_email` matches, **whatever customer row it sits on**. A wallet is an email: an account holder who books signed out gets a guest row with her own address (an account is never found from a typed email), and credit from that booking must still reach her account. Returns `{ total, available }`, `available = max(0, total)`. Nothing is derived from payment status: releases are rows.
- `spendWallet(tx, customerId, ownerEmail, halalas, { bookingId | paymentId, reSpendOf?, giftCardId? })`: **the only way to spend.** Locks the wallet (a transaction advisory lock on the email, since one email can book as two customer rows), reads the balance inside the lock, refuses more than `available`, writes the `spend` row on the row the checkout books as. `reSpendOf` (a release id) marks a revive's second spend. Every write that reads a balance takes the same lock.
- `releaseSpend(tx, spendId)`: writes the matching `release` row. Called in the same transaction as every write that ends a checkout: `markFailed` (`purchase.ts:435`), `releaseWebHold` (`lib/bookings.ts:748`) and the hold sweep (`payment-timeout`), and the undelivered-zero-bill path (gap 7).
- `claimGiftCard(tx, code, email, customerId, signedIn)` and `giftCardValue` (the preview), **built (step 4)**, share one check (`usableCard`):
  - lock the card (the claim);
  - require `active`, not expired, balance > 0, and `email` equal to the card's recipient email (a card with none: any email);
  - insert `+balance` with `owner_email` = `email`, and zero the card;
  - already claimed by `email`: no new row, and it brings what is left of the card (the claim, less the guest spends tagged with it, plus their releases). Once an account exists for the email, a guest gets `gift-card-claimed` ("sign in to use it");
  - anything else answers the same: `gift-card-invalid`. Nothing tells a stranger which part was wrong, and no email is shown.
- `creditCancelled(tx, bookingIds, reason, note?)`: amount per booking = `paidOn` (export it from `lib/payments/refund.ts`) + `wallet_discount_halalas`. `owner_email` = `bookings.customer_email`. Null customer with money → `wallet_decisions`.
- `reverseCredit(tx, paymentId, refundedSoFarHalalas)`: `refundedSoFarHalalas` is StreamPay's **running total** (`refundedSoFar`, `lib/payments/streampay.ts`), not the new amount. Worked out **per payment**, never per booking: a group's one payment funds one credit row per guest, and a per-row sum would take back several times the refund. Under the customer lock:
  - due = min(running total, the card-paid part of every credit that payment funded) − what is already reversed for that payment; 0 → nothing written, so a repeat call is harmless;
  - **cancel or chair credit** (she paid): one `reversal` of `due`, which may take her below 0 → alert + `wallet_decisions`;
  - **gift card claim** (someone else paid): a `reversal` of at most her `available`; the rest → `wallet_decisions` as the salon's loss. If the buyer's email is the recipient's, it is treated as her own payment.
  - What went back beyond the credits (a group where some guests were served) is in the owner's alert that `refundedOutside` already sends for every outside refund, now with what was taken from the wallet. Not a `wallet_decisions` row: it isn't wallet money, and a running total reported again would write it again.
  - Called from `refundedOutside` (`refund.ts`) for full **and** partial refunds, which covers dashboard refunds, the refund webhooks and chargebacks found by the daily comparison.
  - **Built (step 7a)** for cancel and chair credit.
- `reverseGiftCards(tx, paymentIds, refundedSoFarHalalas)`: **built (step 6)**, beside `reverseCredit` in `refundedOutside`. A claimed card's value is in a wallet, so freezing the card does nothing; what is left of it there is taken back instead, never below zero, and the rest is the salon's loss (`gift-card-loss` on "Needs your decision"). A card the buyer bought for her own email is taken back in full, as her own credit would be. The running total less what was taken and what was lost, so a repeat writes nothing.
- `creditChair(tx, paymentId, bookingId, halalas)`: **built (step 7b).** `refundOrCredit` (`purchase.ts`) writes a `chair-credit` to the visit's email in the transaction that marks `owedCredit`, and emails her. The mark stays, since it is what tells the settle job the payment is handled.

### Checkout
- **Bookings. Built (step 4).** `/api/bookings` takes `walletHalalas` (what the screen showed credit paying) and `giftCardCode`. In `createBookings`' transaction, after points, under the wallet's lock:
  1. the wallet is the checkout's email: her account's when signed in, the one she typed otherwise;
  2. a gift card is claimed into that email's wallet (`claimGiftCard`). It works only when that email is its recipient's; the code plus the email is the proof, so there is no separate email field;
  3. what she can spend: signed in, her whole balance; a guest, only what the card just brought (a typed email proves no wallet);
  4. `walletSpendOk` (`lib/money.ts`, the same function the screen uses): what she typed, never more than she can spend or the bill, never leaving the card under 1 SAR (`walletCovers` is the most);
  5. if `walletHalalas` fails it, refused with `wallet-changed` and her real figure: another tab spent it, and she is never charged more in silence;
  6. split across member rows (`wallet_discount_halalas`), and one `spend` row on the first booking. VAT comes out of the lower total, as with a promo.
  - `bookingLines` (`lib/payments/lines.ts`) already names the "Wallet credit" coupon. A bill fully covered goes down the existing zero path.
  - A lapsed hold (the sweep) or one she let go (`releaseWebHold`) writes a `release` for its spend in the same transaction (`releaseBookingSpends`).
  - **A card's leftover.** A guest's spend is tagged with her card (`gift_card_id`), and its release carries the tag back, so typing the code again with the same email brings what is left of that card: after going back to change her service, or on her next visit. Never more than that, so a used card's code and email reach nothing else on that email. Once an account exists for the email, its credit is spent signed in, untagged, so a guest typing the code is told to sign in (`gift-card-claimed`). Any other refusal reads the same (`gift-card-invalid`), and no email is shown.
- **Preview. Built:** `/api/wallet/quote`. GET: live or not, and her balance when signed in. POST `{ code, email }`: what a card brings, without claiming; signed in, the email is always her account's. Throttled per IP like the promo route.
- **UI. Built:** in "Discounts and credit" on `app/(site)/booking/payment/page.tsx`, after the discount code and her points, beside "How you're paying" and the button.
  - **Signed in:** "Pay with wallet" (`WalletAmount`, `components/WalletCredit.tsx`): her balance, an amount she types or Max, and what is left for the card. Her gift cards are already in her wallet, so the card field waits behind "Have a gift card code?", for a card the desk issued with no email.
  - **A guest:** no wallet, a gift card field only. It pays all the card can, and anything left waits in her email's wallet. Her booking email says how much is left and to sign in with that email (`giftCardLeftAfter`, `lib/invoice`).
  - A "Wallet credit" (or "Gift card") line in the summary, and `payableTotal` after it. The card is kept across a reload, and the hold is worked out again server side.
- **Purchases. Built (step 5)** (`startPurchase`, `lib/payments/purchase.ts`):
  - takes `wallet?: { customerId, email, halalas }`, **signed-in only**: every route passes her session's customer and email, never the request's (the chair QR proves presence, not who). The pending payment and `spendWallet` are one transaction under the wallet's lock; `walletSpendOk` checks the amount again there and refuses one it fails (`wallet-changed`, with her real figure), which also keeps the card's part at 1 SAR or more;
  - the card is asked for the rest, with `discounts: [{ label: "Wallet credit", halalas }]` off the full price;
  - a purchase the credit covers never reaches StreamPay: it settles on the spot as a zero payment (gap 6);
  - `markFailed` (declined, abandoned) gives the credit back in the same write; `refundOrCredit` (paid, not delivered, at checkout or by the daily job) gives it back too, and a zero card part is marked `refunded` without StreamPay (gap 7);
  - a gift card is issued for its full value, not for what the card paid;
  - routes: `app/api/packs`, `app/api/gift-cards` (the client allows credit there) and `app/api/station/treat`. A gift card code is not taken on the gift card route: a card doesn't buy a card.
- **Revive. Built:** before a written-off payment that turns up paid is delivered (`settlePurchase`), `reSpendReleased` takes its released credit again (`reSpendOf`). She no longer has it: nothing is delivered, and the card's part is refunded as a late payment. A booking's credit is never released while its hold stands, so only purchases need this.
- **Purchase pages. Built (step 5):** the same amount field (`components/WalletCredit.tsx`, one hook for the three) on the membership, gift card and chair pages, with what is left to pay; a purchase the credit covers shows no card form.

### Cancellation
- **Customer** (`app/api/my-bookings/cancel/route.ts`), **built (step 2c):** `creditCancelled(..., "cancel-customer")` in one transaction with the guarded status update and the pack credit return; there is no card refund for a cancel. The confirm and done copy (`cancelConfirmWallet`, `cancelConfirmGroupWallet`, `cancelledToWallet`, `cancelledNothingPaid`) says it goes to her wallet.
- **Only the booker cancels.** Signed in, the party's customer; a guest, the booking email proved by its code, as today.
- **A group cancels as one, by the booker** (the client, 2026-09-30). One payment, one credit: what was paid for the party, after the 10% group discount (a 100 SAR service billed at 90 gives 90). There is no dropping guests.
- **Salon** (`setBookingStatus`, `app/(admin)/admin/(shell)/bookings/actions.ts`):
  - **switched off (the client, 2026-09-30):** `SALON_CAN_CANCEL = false` refuses any `cancelled` from the salon (`salon-cannot-cancel`), re-saving one included, so her own reason can't be overwritten; `drawerStatuses` offers no cancel button to any role (`tests/salon-never-cancels.test.ts`). Everything below stays built, and its tests switch it back on;
  - **built (step 2a):** the admin form sends the status it showed; the update is `where status = <that status>`, and zero rows back answers "This booking changed. Reload." instead of acting twice;
  - **built (step 2a):** entering `cancelled` requires a reason, and the status change and `returnPackCredits` run in **one transaction**, so a crash leaves all or none. `creditCancelled(..., "cancel-salon", reason)` joins that transaction in step 2c;
  - **built (step 2c):** `creditCancelled(..., "cancel-salon", reason)` runs in that transaction;
  - **built (step 2c):** leaving `cancelled` is refused while the booking has a cancel credit;
  - inside `cancel_cutoff_hours`: refused with "held". Only reachable if the salon cancel is switched back on, and then a question for the client again.
- **No-show (built, step 2b):** `isDead` (`lib/rewards.ts`) no longer voids a `no_show` or no-show-resolved booking. She paid for it, so what it earned counts and what it spent stays spent (the owner, 2026-09-29).
- **Removed** (step 9): `refundBookings` and the `payments.refund` permission.

### Walk-ins retired
- **Built (step 1).** The walk-in button, `WalkInDrawer`, the `createWalkIn` action and the catalogue the drawer loaded are gone. Removed, not hidden: a hidden button leaves the action reachable.
- The front desk still checks in, starts and completes online bookings; only making a booking at the desk goes.
- A customer who arrives without a booking books herself on the app, at the desk if need be.

### Gift card delivery and emails
- **Built (step 6).** `app/api/gift-cards`: `recipientEmail` required (the form already asked for it).
- **Tax:** `giftCardLine(amountSar)` (`lib/payments/lines.ts`): taxed, VAT included in the price.
- **Into her wallet:** `claimCardsFor(email)` (`lib/wallet.ts`) moves every card sent to that email, still active and unexpired, into the wallet of the account with that email. Called by `deliver()` right after a card is issued, and by `createAccount` after the account commits. Neither can fail the sale or the sign-up: a card that doesn't move stays a working code.
- **Recipient email** (`lib/giftcard/email.ts`): already in her wallet ("sign in and use Pay with wallet"), or the code with her email ("booking with this email; what's left stays yours; or sign in and it goes into your wallet now"). A card with no recipient email: the code alone.
- **Buyer receipt** says which: in the recipient's wallet, or that it works only with the recipient's email.
- **Inline image:** `SendMailInput.attachments` gains `cid`, which nodemailer passes through. The PNG is fetched from `/api/gift-card-image` (5 s at most), falling back to the remote `<img>`.
- **`lib/wallet-email.ts`** (built with steps 2 and 7): the cancel credit email, the chair credit email, the owner correction email. Not built: a separate "gift card leftover" email; her wallet on /account shows it.
- **`createAccount`** (`lib/account/create.ts`): nothing moves between rows; a wallet is its email (`walletBalance`), so guest-row credit is hers on sign-up. Then `claimCardsFor`.

### Account screen
- **Built (step 3).** `accountWallet(email)` (`lib/wallet.ts`): `available` and her email's last 10 rows, newest first. `app/(site)/account/page.tsx` adds it to its `Promise.all`, by the email she signs in with.
- **Built.** The header shows her balance on every page, signed in (`components/WalletMenu.tsx`, from GET `/api/wallet/quote`). Its menu splits what she holds by source (`sources`: gift cards; refunds as credit, meaning cancels and chair credit; spent, net of releases; adjustments, meaning corrections and reversals) and shows her last movements.
- `AccountView.tsx` shows a "Wallet" card at the top of the side column, her details under it, and points beside her memberships under the bookings (the old `Wallet` component is renamed `Points`): the amount she can spend, never a negative number, and each movement with its reason and date. Strings (`account.money*`) in both languages. Tests: `tests/account-wallet.test.ts`.

### Admin: "Needs your decision"
- An owner-only page over `wallet_decisions`:
  - a balance below 0 after a reversal;
  - a gift card reversal the recipient's wallet couldn't cover (the salon's loss);
  - money on a cancelled booking with no customer;
  - a customer saying her email was mistyped (staff add it with the booking code and phone they checked);
  - a revived payment that could not be confirmed or delivered.
- Each item has **Correct**: an amount (+ or −), a required reason, written as a `correction` row and to the audit log, and emailed to her. Marking an item done without a correction also needs a reason.
- **Built (step 8a):** `/admin/wallet-decisions`, the `wallet.decide` capability (CEO only), `decideWallet` (closes the case and writes the correction in one transaction, guarded on the case being open, so a double submit writes one), `correctWallet` and `walletOwner` in `lib/wallet.ts`, and the correction email. Not yet: the staff form for a mistyped email, and changing a gift card's email (with step 6).
- **Change a gift card's email. Built:** `changeGiftCardEmail` (`gift-cards/actions.ts`) and a section in the card drawer, for a buyer's typo in the recipient email. `wallet.decide` (the owner), a required reason, audited, and only while the card is still an unused code (the update is guarded on `active`). The new address is sent the card, and it goes into her wallet if she has an account.
- Skipped: a read-only balance in the admin customer screen. Add it when support asks.

## Build order
One commit per step, docs in the same commit. Nothing reaches customers until step 9.
0. VAT: the working approach (Settled). Steps 4 and 5 go ahead on it; the accountant's confirmation is wanted before step 9.
1. **Built.** Migration 0031 (guest rows merged by email, guest identity, `customer_email`, `wallet_discount_halalas`, `wallet_txns`, `wallet_decisions`); `lib/wallet.ts` with `walletBalance`, `spendWallet`, `releaseSpend`; `guestRow` in `createBookings`; `tests/wallet.test.ts` and its mutants; the walk-in flow removed.
2. **Built.** Cancellation: customer, and salon (switched off; one transaction, guarded status, reason, no un-cancel), no-show points, the cancel email. A group cancels as one (the client): there is no dropping guests.
3. **Built.** Account screen: the wallet card and its history.
4. **Built.** Booking checkout: gift card and wallet, quote route, UI.
5. **Built.** Purchase checkouts: `startPurchase` wallet in one transaction and zero path, three routes, releases, revive re-spend, UI.
6. **Built.** Gift cards: required recipient email, taxed when sold, delivery and sign-up claim, chargeback reversal (`reverseGiftCards`), inline image, emails.
7. **Built:** `reverseCredit` in `refundedOutside`, and chair credit; the gift card case is `reverseGiftCards` (step 6).
8. **Built.** "Needs your decision" page, owner correction, and changing a gift card's email.
9. **Built (Option B, the owner, 2026-10-01).** No launch switch: `wallet_launched_at`, `walletLaunched`, `refundBookings`, `payments.refund`, the card-refund cancel copy and the tax-free gift card line are deleted, and the wallet is always on. A booking with no email sends its cancel credit to "Needs your decision" (`no-email`) instead of refusing the cancel. PAYMENTS-STATUS.md §2 updated to "built". Left for go-live: the StreamPay sandbox checks below.

## Verification
**Tests** (`tests/wallet.test.ts`, fake driver as in `tests/streampay.test.ts`):
- cancel more than 3 h before → credit = card + wallet spent; a second cancel call → no second credit;
- salon cancel → credit, reason stored; without a reason → refused; no-show → nothing from the wallet, and its points stand;
- salon cancel with a stale status (someone changed it meanwhile) → refused, nothing written;
- a crash after the status write in a salon cancel → status rolled back, no credit (all or none);
- cancelled with credit → set back to confirmed is refused;
- card 100 / bill 500 → 400 charged; 250/250 → zero path, confirmed; 500/250 → free, 250 left;
- a bill leaving 0.50 SAR → credit capped, 1 SAR charged;
- **two checkouts at once** (a booking and a membership, 300 SAR balance, 300 each) → one succeeds, one is refused;
- abandoned hold → `release` row, balance back;
- **revive after release**: spend released, then the payment turns up paid → re-spend written (not refused by the unique index) and delivered; balance already spent elsewhere → not delivered, card part refunded;
- **shared phone**: Sara books with phone 050 and sara@, cancels; Noura books with 050 and noura@; Noura signs up → Noura has no credit; Sara signs up → she has it;
- **old walk-in record**: a record with phone 055 and no email; an online booking with 055 and fatima@ → that record takes the email, no new row, her visits and points stay with her; a later sign-up with fatima@ gets them;
- the walk-in button is not shown at the desk;
- **gift card lock**: the right code with the wrong email → "This card can't be used", card untouched; the right pair → claimed, leftover tagged to the recipient email; the right pair again after an abandoned checkout → what is left of it; a card issued with no email → the code alone works;
- owner changes an unclaimed card's email with a reason → audited, the new email works and the old one doesn't; on a claimed card → refused;
- **group partial refund**: one 400 payment for 4 guests, all cancelled; running total 100 → one reversal of 100 (not 400);
- signup claims an active card locked to that email and skips an expired one;
- a gift card bought partly with credit → a `spend` row on its payment, and the card issued for its full value; a gift card code on the gift card route → refused;
- a purchase fully covered by credit → delivered with no StreamPay call; undelivered → `release` row;
- **chargeback** on a payment that funded a cancel credit (found by the daily comparison) → `reversal` row; already spent → available 0, owner alerted;
- **two partial refunds**: 400 credit, StreamPay's running total 100 then 250 → reversals of 100 then 150; the same total reported again → nothing written;
- **gift card fraud**: 500 card claimed, 400 spent, the buyer's payment charged back → reversal of 100, balance 0, a `wallet_decisions` row for 400; her own later 300 cancel credit → 300 available;
- owner correction without a reason → refused; with one → row + audit entry;
- a booking with no email → her cancel goes through, and its money goes to "Needs your decision";
- `owedCredit` on a `paid` payment converts once; on a `refunded` one it doesn't.

**Checks:** `npx tsc --noEmit`, `npm test`, `next build`.

**Sandbox:** a discounted link's total equals ours; the tax invoice shows the "Wallet credit" coupon; a 1 SAR link is accepted; the gift card email shows the image in Gmail with images off.
