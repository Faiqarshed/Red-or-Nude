# Wallet plan

## Context
Once a booking is confirmed, money never goes back to the card. It becomes **wallet credit** (decided in PAYMENT-HARDENING-PLAN.md, "Refund rule"). Gift cards also become wallet credit. Today:
- no money wallet exists (the /account "wallet" holds loyalty points);
- her own cancel still refunds the card (`refundBookings`);
- a salon cancel moves no money;
- nothing can spend a gift card: `adjustGiftCardBalance` is called only by the admin adjust action.

Goal: one wallet per customer. It is filled by cancellations, gift cards and small chair refunds, and spent at every checkout except buying gift cards. A guest's credit belongs to her **email**, and waits until she signs in with it.

Fixed decisions:
- **Spent at:** bookings (with their chair add-ons), memberships, chair QR purchases. **Not** gift card purchases: credit turned into a gift card code can be sold for cash, and a stolen card behind the credit is charged back later.
- **Never expires (confirmed by the client).** An unclaimed gift card keeps its own `expiresAt`. Once claimed into the wallet, the credit never expires.
- **Walk-ins are retired.** Every booking comes through the online app, with an email. The desk's walk-in flow (`WalkInDrawer`) is hidden. Old walk-in records (a phone, no email) are joined by her first online booking with that phone.
- **A guest is her email.** Every credit is tagged with the email of the booking or card it came from, and only a sign-in with that email reaches it.
- **A gift card is locked to its recipient's email.** At checkout the code works only together with that email, and anything left over is tagged to it. Someone who sees the code alone can't use it or lock it. Cards sold before launch stay unlocked: they were sold as "the code is the card".
- **Only the booker cancels, and nobody refunds from StreamPay's dashboard.** Both are policy. The code still handles a dashboard refund or a chargeback safely (`reverseCredit`), because a rule is not a lock and a bank can reverse a payment whatever we decide.
- **Every change is a row.** Spends, releases, reversals and corrections are all written to the ledger, so "why did my balance change?" is answered from the table alone.
- **She never sees a negative balance.** Shown and spendable: `max(0, sum)`. Only a customer who paid and then got that money back can owe the wallet; the debt is kept in the table and paid off by her next credits first. A gift card's recipient never owes anything for the buyer's payment.
- **Only the owner corrects, with a reason.** No staff action writes to the ledger. The owner can add a `correction` row from the "Needs your decision" page, with a required reason, recorded in the audit log.
- **It goes live all at once, and only once.** Built in steps, but customers see nothing (no "added to your wallet", no wallet card, no credit switch) until every step is done. A `wallet_launched_at` setting, empty until the last step, gates it. It is set once and never cleared (clearing it would hide credit customers already hold), and it is never put on an admin screen. It also dates the launch, which is what tells an old, unlocked gift card from a new one.
- **Gift card email:** the brand card image goes inline (cid attachment), so it shows without "load images".

## Open questions
**For the client (to send): our assumption, not decided.**
0. **A group dropping guests.** Today a group cancels as one (CLAUDE.md, `app/api/my-bookings/cancel/route.ts:75`). Our assumption: a group can drop guests as long as 2 stay. The 10% group discount holds for any 2 or more, so the guests who stay still pay a fair group price. Leaving 1 is refused: she cancels the whole group or none. Each cancelled guest's credit is what she actually paid, after the discount. No cap on how many are dropped. **Nothing that depends on it is built until the client agrees.** Until then the whole-group cancel stays the only one, and every other step goes ahead.

**For the client (sent, waiting):**
1. ~~Salon cancel inside 3 h~~: answered, see Settled.
2. **VAT** (the accountant): gift cards taxed at sale or at redemption; a credit note for a cancelled booking; credit spent as a StreamPay coupon. **Build step 0**: if credit must be a payment method and not a discount, steps 4 and 5 change, because StreamPay links only take coupons.
3. **One sentence for the refund policy.** Card refunds still happen when she pays late, pays the wrong amount, pays twice, or buys something we can't deliver. Proposed: "A payment that bought nothing goes back to the card; everything else goes to the wallet." Written into PAYMENTS-STATUS.md once agreed.
4. **Invoice wording.** "Wallet credit" and "Gift card" lines print on StreamPay's tax invoice as coupons, the way promo codes do (PR #21 Q4). Is that wording right for the client?

**For us, before step 2:**
6. **Bookings made before step 1 have no `customer_email`.** Their cancel credit has no email to belong to. Either take the customer row's email (the unreliable one, gap 3) or send each to "Needs your decision". Decide before step 2 writes cancel credit.

**For StreamPay support:**
5. What status does a chargeback show on a payment: `REFUNDED`, or something like `DISPUTED`? Is there a disputes API or webhook? Today there is no chargeback event (`app/api/payments/streampay/webhook/route.ts`), and the daily comparison is what finds one.

**Settled:**
- **The salon never cancels a booking** (the client, 2026-09-30), inside 3 h or not. Only she cancels. Switched off by `SALON_CAN_CANCEL = false` (`lib/cancellation.ts`), not deleted: the desk's cancel stays built and tested, for the day the client wants it back (a technician off sick). Switching it back on reopens the 3 h question with the client.
- Credit never expires (the client).
- StreamPay's payment page has no field for typing a coupon (checked in the sandbox). If one appears, a payment below our amount is already refunded and nothing is given for it (`confirm.ts` "wrong-amount", `purchase.ts` "wrong-amount").

## Launch blockers
Built around, not decided. Each is a refusal (`WalletHeld`, "held") or an `it.todo` in the tests, and `wallet_launched_at` is not set until every one is answered:
- **Open question 6:** a booking with no `customer_email` is refused with "held" when cancelling after launch (`creditCancelled`).
- **Open question 2 (VAT):** steps 4 and 5 don't start.
- **Open question 0 (group drop):** not a blocker. Without an answer the wallet launches with the whole-group cancel only.

## How money enters and leaves

| Event | Wallet |
|---|---|
| She cancels more than 3 h before | **+** card paid on that booking + wallet spent on it |
| Salon cancels | Never (the client, 2026-09-30): refused, and no cancel button. Switched back on (`SALON_CAN_CANCEL`), **+** same amount, reason required |
| She cancels within 3 h | Not allowed (already enforced) |
| A cancelled booking with a cancel credit set back to confirmed | Refused. The desk makes a new booking |
| No-show (`resolveNoShow`, marked no-show) | Nothing. Her points on it stand: what it earned counts, what it spent stays spent |
| Gift card bought for an email that has an account | **+** full card value on delivery. The card becomes `redeemed` |
| Gift card code + its recipient email entered at checkout | **+** the card's whole balance, tagged to the recipient email, then spent on the bill. Anything left stays in that email's wallet. A card sold before launch needs the code alone, and its leftover goes to the email she books with |
| The booker drops guests from a group (2 or more stay). *Assumption, open question 0* | **+** each dropped guest's discounted price |
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
2. **No cancellation email exists.** `notifyCustomer("booking-cancelled")` only logs to the console (`lib/notify/log.ts`). **Built (step 2d):** after launch, both cancels send `sendCancelCreditEmail` (`lib/wallet-email.ts`): the amount, her balance, the salon's reason when it cancelled, and for a guest the email to sign in with. It carries no tax document (open question 2). Before launch nothing changes.
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
14. **A gift card code alone is enough to use it.** The buyer sees the code on the success screen and shares it (WhatsApp); anyone holding it could claim the card into their own wallet, even by starting a checkout and abandoning it. Closed by the recipient-email lock. `recipientEmail` (and `buyerEmail`) are optional today (`app/api/gift-cards/route.ts:35`, `purchase.ts:37-39`): the recipient's becomes required on the form. Cards sold before launch have no lock and work with the code alone, as they were sold.
15. **A group cancels only as a unit** (`app/api/my-bookings/cancel/route.ts:75`), because the 10% exists only while 2 or more book together. Kept as the rule. Letting a larger party drop guests down to 2 is our assumption, waiting on the client (open question 0).

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
- Card claim: set the card to `redeemed` with balance 0, and add a `gift_card_txns` row (`reason: "to-wallet"`, `bookingId` when claimed at checkout). No new gift card column: the lock email is `recipientEmail` on a card created after `wallet_launched_at`; an older card has none.
- `wallet_launched_at` in `lib/settings.ts`, default empty. Not on any admin screen.

### `lib/wallet.ts` (one file)
- `walletBalance(ownerEmail, executor?)`: SUM(delta) over every row whose `owner_email` matches, **whatever customer row it sits on**. A wallet is an email: an account holder who books signed out gets a guest row with her own address (an account is never found from a typed email), and credit from that booking must still reach her account. Returns `{ total, available }`, `available = max(0, total)`. Nothing is derived from payment status: releases are rows.
- `spendWallet(tx, customerId, ownerEmail, halalas, { bookingId | paymentId, reSpendOf? })`: **the only way to spend.** Locks the wallet (a transaction advisory lock on the email, since one email can book as two customer rows), reads the balance inside the lock, refuses more than `available`, writes the `spend` row on the row the checkout books as. `reSpendOf` (a release id) marks a revive's second spend. Every write that reads a balance takes the same lock.
- `releaseSpend(tx, spendId)`: writes the matching `release` row. Called in the same transaction as every write that ends a checkout: `markFailed` (`purchase.ts:435`), `releaseWebHold` (`lib/bookings.ts:748`) and the hold sweep (`payment-timeout`), and the undelivered-zero-bill path (gap 7).
- `claimGiftCard(tx, code, email, customerId)`:
  - lock the card;
  - require `active`, not expired, balance > 0, and `email` equal to the card's lock email (an old card has no lock: any email);
  - insert `+balance` with `owner_email` = the lock email (an old card: `email`), and zero the card.
  - The right code **and** the right email, but already claimed (her own abandoned checkout): "This card's value is in the wallet of this email. Sign in to use it." She has proved both, so the truth is safe to tell.
  - Anything else (wrong email, expired, unknown) answers the same: "This card can't be used." Nothing tells a stranger which part was wrong, and no email is shown.
- `creditCancelled(tx, bookingIds, reason, note?)`: amount per booking = `paidOn` (export it from `lib/payments/refund.ts`) + `wallet_discount_halalas`. `owner_email` = `bookings.customer_email`. Null customer with money → `wallet_decisions`.
- `reverseCredit(tx, paymentId, refundedSoFarHalalas)`: `refundedSoFarHalalas` is StreamPay's **running total** (`refundedSoFar`, `lib/payments/streampay.ts`), not the new amount. Worked out **per payment**, never per booking: a group's one payment funds one credit row per guest, and a per-row sum would take back several times the refund. Under the customer lock:
  - due = min(running total, the card-paid part of every credit that payment funded) − what is already reversed for that payment; 0 → nothing written, so a repeat call is harmless;
  - **cancel or chair credit** (she paid): one `reversal` of `due`, which may take her below 0 → alert + `wallet_decisions`;
  - **gift card claim** (someone else paid): a `reversal` of at most her `available`; the rest → `wallet_decisions` as the salon's loss. If the buyer's email is the recipient's, it is treated as her own payment.
  - What went back beyond the credits (a group where some guests were served) is in the owner's alert that `refundedOutside` already sends for every outside refund, now with what was taken from the wallet. Not a `wallet_decisions` row: it isn't wallet money, and a running total reported again would write it again.
  - Called from `refundedOutside` (`refund.ts`) for full **and** partial refunds, which covers dashboard refunds, the refund webhooks and chargebacks found by the daily comparison.
  - **Built (step 7a)** for cancel and chair credit. The gift card case joins it in step 6.
- `creditChair(tx, paymentId, bookingId, halalas)`: **built (step 7b).** After launch, `refundOrCredit` (`purchase.ts`) writes a `chair-credit` to the visit's email in the transaction that marks `owedCredit`, and emails her. The mark stays, since it is what tells the settle job the payment is handled. Before launch it marks only. **Launch (step 9)** still owes a one-off pass converting existing `owedCredit` marks **only where the payment is still `paid`**, emailing each.

### Checkout
- **Bookings.** `/api/bookings` takes `giftCard?: { code, email }` and `useWallet?`. In `createBookings`' transaction, after points (`lib/bookings.ts:1322`), under the existing customer row lock:
  1. claim the card if one was given;
  2. spend `min(available, remaining bill)` through `spendWallet`. Signed in, `available` is her balance. For a guest it is only what this card just brought in;
  3. apply the 1 SAR cap;
  4. split the spend across member rows.
  - `bookingLines` (`lib/payments/lines.ts:35`) adds a discount "Wallet credit". A bill fully covered goes down the existing zero path.
- **Preview:** `/api/wallet/quote` (modelled on `/api/loyalty/quote`) returns the balance, and the value of a card only when code and email match, **without claiming**.
- **Purchases** (`startPurchase`, `lib/payments/purchase.ts:88`):
  - takes `wallet?: { customerId, halalas }`, **signed-in only**; the pending payment insert and `spendWallet` run in **one transaction**;
  - passes `discounts: [{ label: "Wallet credit", halalas }]`;
  - adds a zero-bill path.
  - Routes: the membership/pack route and the chair treat route (QR alone is not identity). **Not** `app/api/gift-cards`: it refuses `wallet` and gift card codes.
- **Revive** (`revivePayment`, `lib/payments/settle.ts:74`): before a revived payment confirms or delivers, its released spend is taken again through `spendWallet(..., { reSpendOf })`. If the balance no longer covers it, nothing is confirmed or delivered, and the card part is refunded under the late-payment rule.
- **UI:** `app/(site)/booking/payment/page.tsx` gets "Gift card number" and "Email it was sent to" fields, and a "Use my credit (X SAR)" switch when signed in. `payableTotal` subtracts it, and the `nothingToPay` copy stops saying "your membership covers this". The same switch goes on the membership and chair pay pages, not the gift card page. All of it hidden until `wallet_launched_at` is set.

### Cancellation
- **Customer** (`app/api/my-bookings/cancel/route.ts`), **built (step 2c):** after launch, `creditCancelled(..., "cancel-customer")` replaces `refundBookings`, in one transaction with the guarded status update and the pack credit return. Before launch the old path runs unchanged. Copy in `lib/dictionary.ts` (`cancelConfirm`, `cancelConfirmGroup`, `cancelled`, `cancelledNoRefund`) changes from "back to your card" to "to your wallet". **Built (step 2d):** the `*Wallet` strings show when `BookingSummary.cancelToWallet` is true, which the server sets from `wallet_launched_at`. Until then the card refund and its copy stay.
- **Only the booker cancels.** Signed in, the party's customer; a guest, the booking email proved by its code, as today.
- **Dropping guests from a group** *(assumption, open question 0; not built until the client agrees)*: the route takes the guest ids to drop. Allowed only when 2 or more stay and none of the dropped is past `cancelRefusal`. Each dropped guest's credit is her own discounted share (`splitGroupPrice`, as billed), so the guests who stay keep their 10% and nobody gains a discount they didn't have. Leaving 1 → "Cancel the whole group instead." The whole-group cancel stays as it is.
- **Salon** (`setBookingStatus`, `app/(admin)/admin/(shell)/bookings/actions.ts`):
  - **switched off (the client, 2026-09-30):** `SALON_CAN_CANCEL = false` refuses any `cancelled` from the salon (`salon-cannot-cancel`), re-saving one included, so her own reason can't be overwritten; `drawerStatuses` offers no cancel button to any role (`tests/salon-never-cancels.test.ts`). Everything below stays built, and its tests switch it back on;
  - **built (step 2a):** the admin form sends the status it showed; the update is `where status = <that status>`, and zero rows back answers "This booking changed. Reload." instead of acting twice;
  - **built (step 2a):** entering `cancelled` requires a reason, and the status change and `returnPackCredits` run in **one transaction**, so a crash leaves all or none. `creditCancelled(..., "cancel-salon", reason)` joins that transaction in step 2c;
  - **built (step 2c):** after launch, `creditCancelled(..., "cancel-salon", reason)` runs in that transaction;
  - **built (step 2c):** leaving `cancelled` is refused while the booking has a cancel credit;
  - inside `cancel_cutoff_hours`: refused with "held" after launch. Only reachable if the salon cancel is switched back on, and then a question for the client again.
- **No-show (built, step 2b):** `isDead` (`lib/rewards.ts`) no longer voids a `no_show` or no-show-resolved booking. She paid for it, so what it earned counts and what it spent stays spent (the owner, 2026-09-29).
- **Remove** `refundBookings` and the `payments.refund` permission (`lib/auth/rbac.ts:42,70`) at launch, once `wallet_launched_at` is set.

### Walk-ins retired
- **Built (step 1).** The walk-in button, `WalkInDrawer`, the `createWalkIn` action and the catalogue the drawer loaded are gone. Removed, not hidden: a hidden button leaves the action reachable.
- The front desk still checks in, starts and completes online bookings; only making a booking at the desk goes.
- A customer who arrives without a booking books herself on the app, at the desk if need be.

### Gift card delivery and emails
- `app/api/gift-cards` and its form: `recipientEmail` required.
- `deliver()` (`purchase.ts:313`): if the recipient email matches a verified account, claim the card into that wallet right away.
- **Recipient email** (`lib/giftcard/email.ts`), card image always inline:
  - account holder: "Your X SAR gift card from <buyer> is in your Red or Nude wallet."
  - no account: the code, plus "Enter it at checkout with this email. What's left goes to your wallet. Or sign in with this email and it's added now."
- Inline image: `SendMailInput.attachments` gains `cid?`, and the mail transport passes it through. The PNG is fetched from `/api/gift-card-image`, best-effort, falling back to the remote `<img>`.
- **Buyer receipt** says which of the two happened, and that the card works only with the recipient's email.
- **`lib/wallet-email.ts` → `sendWalletEmail(kind, …)`** on `brandedEmail` + `sendReceipt`:
  - cancel credit (hers and the salon's): this is the missing cancel email;
  - gift card leftover;
  - chair credit;
  - reversal;
  - owner correction.
  - A guest's version adds "Sign in with <email> at /account to use it."
- **`createAccount`** (`lib/account/create.ts`):
  - also moves `wallet_txns` whose `owner_email` matches onto the account;
  - then claims active, unexpired cards locked to that email.

### Account screen
- `app/(site)/account/page.tsx` adds `walletBalance` and the last 10 rows to its `Promise.all`.
- `AccountView.tsx` gets a "Wallet" card for money next to the points card (`Wallet` at :441 is renamed `Points`) and a short history. Strings go in `lib/dictionary.ts` in both languages. The card shows `available`, never a negative number.

### Admin: "Needs your decision"
- An owner-only page over `wallet_decisions`:
  - a balance below 0 after a reversal;
  - a gift card reversal the recipient's wallet couldn't cover (the salon's loss);
  - money on a cancelled booking with no customer;
  - a customer saying her email was mistyped (staff add it with the booking code and phone they checked);
  - a revived payment that could not be confirmed or delivered.
- Each item has **Correct**: an amount (+ or −), a required reason, written as a `correction` row and to the audit log, and emailed to her. Marking an item done without a correction also needs a reason.
- **Built (step 8a):** `/admin/wallet-decisions`, the `wallet.decide` capability (CEO only), `decideWallet` (closes the case and writes the correction in one transaction, guarded on the case being open, so a double submit writes one), `correctWallet` and `walletOwner` in `lib/wallet.ts`, and the correction email (sent only after launch). Not yet: the staff form for a mistyped email, and changing a gift card's email (with step 6).
- **Change a gift card's email:** for a buyer's typo in the recipient email. Owner only, a required reason, audited, and only while the card is unclaimed. The new recipient gets the gift card email.
- Skipped: a read-only balance in the admin customer screen. Add it when support asks.

## Build order
One commit per step, docs in the same commit. Nothing reaches customers until step 9.
0. The accountant's VAT answer (open question 2). Steps 4 and 5 don't start without it.
1. **Built.** Migration 0031 (guest rows merged by email, guest identity, `customer_email`, `wallet_discount_halalas`, `wallet_txns`, `wallet_decisions`); `lib/wallet.ts` with `walletBalance`, `spendWallet`, `releaseSpend`; `guestRow` in `createBookings`; `tests/wallet.test.ts` and its mutants; the walk-in flow removed. `wallet_launched_at` moves to step 2, where the first thing reads it.
2. **Built**, except what is held (see Launch blockers). Cancellation: customer and salon (one transaction, guarded status, reason, no un-cancel), no-show points, the cancel email. Behind `wallet_launched_at`. Dropping guests from a group comes after, in its own commit, only once the client agrees (open question 0).
3. Account screen: the wallet card and its history.
4. Booking checkout: gift card and wallet, quote route, UI.
5. Purchase checkouts: `startPurchase` wallet in one transaction and zero path, two routes, releases, revive re-spend, UI.
6. Gift cards: required recipient email, the email lock, delivery claim, `createAccount` claim/merge, inline image, emails.
7. **Built:** `reverseCredit` in `refundedOutside`, and chair credit after launch. Left for launch: converting `owedCredit` marks made before it. The gift card case of `reverseCredit` waits for step 6.
8. "Needs your decision" page, owner correction (**built**), and changing a gift card's email.
9. Launch: set `wallet_launched_at`, remove `refundBookings` and `payments.refund`, PAYMENTS-STATUS.md §2 updated to "built".

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
- **gift card lock**: the right code with the wrong email → "This card can't be used", card untouched; the right pair → claimed, leftover tagged to the recipient email; the right pair again after an abandoned checkout → "This card's value is in the wallet of this email"; a card sold before launch → the code alone works;
- owner changes an unclaimed card's email with a reason → audited, the new email works and the old one doesn't; on a claimed card → refused;
- **group drop** (only if the client agrees, open question 0): 5 guests, drop 3 → 2 stay at 10% off, 3 credits of each one's discounted price; 2 guests, drop 1 → refused; someone other than the booker → refused;
- **group partial refund**: one 400 payment for 4 guests, all cancelled; running total 100 → one reversal of 100 (not 400);
- signup claims an active card locked to that email and skips an expired one;
- gift card purchase with `wallet` → refused;
- a purchase fully covered by credit → delivered with no StreamPay call; undelivered → `release` row;
- **chargeback** on a payment that funded a cancel credit (found by the daily comparison) → `reversal` row; already spent → available 0, owner alerted;
- **two partial refunds**: 400 credit, StreamPay's running total 100 then 250 → reversals of 100 then 150; the same total reported again → nothing written;
- **gift card fraud**: 500 card claimed, 400 spent, the buyer's payment charged back → reversal of 100, balance 0, a `wallet_decisions` row for 400; her own later 300 cancel credit → 300 available;
- owner correction without a reason → refused; with one → row + audit entry;
- `wallet_launched_at` empty → her cancel still refunds the card, and no wallet copy, card or switch shows;
- `owedCredit` on a `paid` payment converts once; on a `refunded` one it doesn't.

**Checks:** `npx tsc --noEmit`, `npm test`, `next build`.

**Sandbox:** a discounted link's total equals ours; the tax invoice shows the "Wallet credit" coupon; a 1 SAR link is accepted; the gift card email shows the image in Gmail with images off.
