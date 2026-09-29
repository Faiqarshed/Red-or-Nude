# Red or Nude — working rules

Salon booking site + staff panel. Next.js 14 App Router, Drizzle/Postgres (Supabase),
StreamPay, Arabic-first bilingual (RTL). Detail lives in `docs/`; this file is the
rules. If this file and a doc disagree, this file wins — then fix the doc.

## Before you build: say how it breaks
Nothing gets written until you have answered, in your reply:
1. **How does this fail?** Double click, two tabs, retry after timeout, webhook
   arriving twice or before the redirect, crash between two writes, stale status
   (someone changed it meanwhile), a Riyadh day boundary, a guest with no account,
   a group of 4, a zero bill, a hostile request that skips the UI.
2. **What already exists?** Search `lib/` for the rule/helper first. Reuse it.
3. **What is the smallest change that closes it?**
If a rule below is unclear or two sources disagree — **stop and ask**. Never pick one.

## Test first (TDD)
Every behaviour change goes red → green → clean, in that order:
1. **Red:** write the test for the rule or for each failure you named above, in
   `tests/<area>.test.ts` (real Postgres; reuse `tests/helpers.ts`, `tests/as-staff.ts`).
   Run it and **show it failing for the right reason**. A test that passes before
   the fix tests nothing.
2. **Green:** write the least code that makes it pass. Nothing it doesn't ask for.
3. **Clean:** remove duplication, keeping everything green. Run the whole `npm test`.
4. **Pin it:** for a money, permission, or window rule, add a mutant to
   `tests/mutations.mjs` that reverts the fix, and check `npm run test:mutations`
   catches it in that test file.
Bug fix = first a test that reproduces the bug, then the fix. No test-free changes to
`lib/`, API routes or server actions. Copy and layout-only UI changes are exempt.
Assert the rule (amounts, statuses, refusal reason), not just "no error thrown".

## Engineering rules
- **Write each rule once.** A rule is one pure function in `lib/` used by both the
  screen and the server (see `lib/cancellation.ts`, `lib/refill.ts`,
  `promoRefusal`). Never copy a rule into a component — a copied rule drifts.
- **No overengineering.** No abstraction for one caller, no config for a value that
  never changes, no speculative options, no new dependency when a few lines do it.
  Three similar lines beat a premature helper; the third copy earns the helper.
- **No design drift.** Match the file next to you: naming, comment density, idiom.
  Admin screens are `page.tsx` + `data.ts` + `actions.ts` + `<Name>View.tsx`.
  Use the existing primitives (`components/admin/ui.tsx`, `overlays.tsx`,
  `usePendingAction().act`) — no component library, no new visual language.
  Site visuals follow Figma tokens in `tailwind.config.ts`.
- **Server decides.** Every action checks `requireCan`/`requirePage`
  (`lib/auth/guard.ts`). Middleware and hidden buttons are not security.
- **Every mutation is audited** with `recordAudit` (`lib/audit.ts`).
- **Money:** integer halalas only (`lib/money.ts`, `formatSAR`). Prices include 15%
  VAT. Prices are snapshotted onto the booking — never join the catalogue for a
  past price.
- **Balances are ledgers.** Points, gift cards, packs, (wallet): a sum of rows, never
  a column you overwrite. Writes happen in one transaction under the customer row
  lock; idempotency comes from unique indexes, not from "checking first".
- **Multi-step writes are one transaction with a status guard**
  (`where status = <expected>`). Two writes with a try/catch between them is a bug.
- **Time:** stored UTC; every "day" is a Riyadh day (`lib/time.ts`, UTC+3, no DST).
- **i18n:** every string in Arabic and English (`lib/dictionary.ts` /
  `lib/admin`); logical Tailwind only (`ps/pe`, `start/end`, `text-start`).
- A `"use server"` file exports only async functions; constants/types go in a plain module.
- Settings come from `lib/settings.ts` (`SETTING_DEFAULTS`) — no magic numbers.

## Business rules (do not change without the owner saying so)
**Refunds & wallet** (docs/WALLET-PLAN.md, docs/PAYMENT-HARDENING-PLAN.md)
- **No refund to the card once a booking is confirmed or an item delivered.**
  After that it is wallet credit or nothing.
- The card is refunded automatically only when she paid and got nothing: paid after
  the hold expired, paid for a slot already started, wrong amount, paid twice, gift
  card/membership could not be issued. Always the whole bill — no partial refunds.
- Undelivered chair purchase ≤ 10 SAR → credit, not card (`CHAIR_CREDIT_MAX_HALALAS`).
- Wallet (planned, being built): credit belongs to an **email**, never expires, never
  shows negative, one cancel credit per booking, can pay bookings/memberships/chair
  items but **not gift cards**, leaves ≥ 1 SAR to charge unless it covers the whole
  bill. Only the owner (CEO) can correct a balance, with a reason, audited. Staff
  actions never write to the ledger. A chargeback writes a `reversal` row.
- ⚠ Until `wallet_launched_at` is set, a customer cancel still refunds the card
  (`refundBookings` in `app/api/my-bookings/cancel/route.ts`). That is legacy pending
  the wallet — do not copy it anywhere new. After launch it credits the wallet
  (`creditCancelled`, `lib/wallet.ts`).

**Cancel, reschedule, no-show**
- Customer may cancel/reschedule only `pending`/`confirmed` bookings, until 3 h before
  (`cancel_cutoff_hours`); exactly on the deadline is too late. Rule: `cancelRefusal`
  in `lib/cancellation.ts`. Guests confirm with an OTP.
- A group cancels as one; reschedule moves only the quoted booking.
- Staff reschedule ignores the window. A salon cancel requires a reason and credits
  her in full. ⚠ **Salon cancel inside 3 h is an open question with the client —
  ask before building anything that depends on it.**
- No-show: not checked in within `no_show_grace_min` (20) → released by `sweepNoShows`,
  7-day lookback. Moves no money. She paid, so a no-show keeps its points: what it
  earned counts and what it spent stays spent (`isDead` in `lib/rewards.ts`).
- A cancelled booking holding a cancel credit can never be set back to confirmed.

**Payments (StreamPay)**
- We price, StreamPay collects. Discounts go as fixed coupons; if StreamPay's total
  ≠ ours, cancel the link. Paid is only believed after asking StreamPay directly.
- One live payment per booking. A zero bill never reaches StreamPay. Never edit
  StreamPay products — versions are new products.
- StreamPay's invoice is the only tax invoice.

**Pricing & discounts**
- Order: gross → group/refill → promo → points → wallet. Each capped at the bill.
- Group: max 4 guests, same Riyadh day, 10% off combined, one rounding split.
- Checkout treats are never discounted and take 0 minutes.
- Refill: one per booking, appointment must have happened, a refill earns no refill.
- Packs: solo bookings only, not stacked with promo/points on the same line; credit
  returns on an in-window cancel, stays spent on a late cancel.
- Promo: a use counts once per bill at payment; codes are deactivated, never deleted.
- Staff code: 90% off, once per Riyadh month.
- Points: 50 at 199 SAR then every 200 SAR; 1 pt = 20 halalas; spent in 50s.
  Points earned on a guest booking count on the account with that email
  (`loyaltyBalance`); spending needs her signed in. Never say to a guest whether
  an email has an account or points.
- Gift cards: preset amounts only; charge first, issue second.

**Roles** (`lib/auth/rbac.ts` is the truth)
- `ceo` > `admin` > `receptionist` > `technician`. Nobody grants above their own role;
  the last CEO cannot be demoted.
- Admin **cannot** reschedule or change booking status (taken back 2026-09-01).
- Technicians see only their own rows and no prices.
- `deleteBooking` refuses anything paid, reviewed, pointed, or pack-credited.

**Identity**
- Email is the customer's identity. Sign-in code: 1 minute, 5 attempts.

## Open questions — ask, don't guess
- Salon cancel inside 3 h (above).
- VAT on gift cards and credit notes (waits on the accountant; blocks wallet step 3).
- A group dropping guests down to 2 (docs/WALLET-PLAN.md open question 0). Our
  assumption only; until the client agrees, a group cancels as one.

## Verify before saying done
- `npx tsc --noEmit` · `npm run lint` · `npm test` (real Postgres, serial)
- Touched a rule with a mutant? `npm run test:mutations` — every mutant must be caught.
- Relevant `npm run check:*` script for the area; `npm run build` for route/layout changes.
- Schema change: `npm run db:generate`; hand-written migration needs a journal `when`
  later than the last one, or drizzle skips it silently. Never `db:push` to production.
- Report failures as failures. No "should work".

## Commits
- One change per commit, its docs in the same commit.
- Subject is a plain sentence saying what changed for the salon
  ("Close the checkout when its timer ends"), body says why.
- No AI co-author or "Generated with" lines.
