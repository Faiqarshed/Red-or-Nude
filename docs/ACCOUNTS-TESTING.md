# Manual testing — customer accounts and loyalty (brief §2.8)

A walkthrough you can follow start to finish. Roughly 25 minutes for §§1–7;
§8 (security) is another 10 and is the part worth not skipping.

Companion to [`docs/CUSTOMER-ACCOUNTS.md`](./CUSTOMER-ACCOUNTS.md), which
explains *why* each of these behaves the way it does.

---

## 0. Setup

```bash
npm run check:loyalty          # pure rules — should pass before you touch a browser
npm run db:migrate             # applies 0011_customer_accounts
npm run dev
```

**Getting the sign-in code.** If `SMTP_HOST` / `SMTP_USER` / `SMTP_PASSWORD` are
set, codes arrive by email — check with `npm run check:mail`. If they are not,
`lib/otp-email.ts` prints the code to the **`npm run dev` terminal** instead:

```
[otp] DEV ONLY — code for sara@example.com is 481902
```

That fallback is guarded on `NODE_ENV !== "production"` and on mail having
actually failed, so it can never fire on a deployed build or on a dev box with
working SMTP.

**Watch two things throughout:** the dev server terminal (codes, and any
`[loyalty]` / `[account]` warnings) and the browser devtools **Application →
Cookies** panel.

Useful SQL, if you have `psql` or `npm run db:studio` open:

```sql
-- the wallet, raw
select delta_points, reason, booking_id, created_at from loyalty_txns
 where customer_id = '<id>' order by created_at;

-- what the balance query actually sees
select b.status, b.created_at, lt.delta_points from loyalty_txns lt
  left join bookings b on b.id = lt.booking_id where lt.customer_id = '<id>';
```

---

## 1. Signing up

1. Open `/`. Beside the **English/العربية** toggle there is a **Sign in**
   button. The centre nav shows **Bookings**.
2. Click it → `/account`. You get an email field, and below the form the reward
   ladder as an advert (100 → 5%, 200 → 10%, 300 → 15%). ✅ *The ladder is shown
   signed out on purpose — it is the reason to make an account.*
3. Enter a fresh address → **Send code**. The screen moves to the code step and
   says *"We sent a code to s•••@example.com"*.
   ✅ *Masked, not echoed back in full.*
4. Type the code → **Continue**. Because the address is new, the screen asks for
   name, mobile and birthday — it does **not** send you back to a separate
   sign-up page.
5. Leave birthday empty, fill name and mobile, → **Create account**.

**Expect:** you land on `/account` signed in. The **Sign in** button is **gone**
from the header — check `/`, not just `/account` — and the centre nav's
**Bookings** entry has been *replaced* by **Profile**. **Sign out** lives on the
page itself, top right, not in the header.

**Check the cookie:** Application → Cookies → `ron_account`. It must be
`HttpOnly ✓`, `SameSite: Lax`, and its value must be opaque gibberish — if you
can read a customer id in it, something is very wrong.

---

## 2. Signing out and back in

1. **Sign out** on `/account`. You land on `/`, the nav says **Bookings** again,
   and `ron_account` is gone from the cookie panel.
2. Sign in again with the same address. After the code, you go **straight in** —
   no profile form this time.
   ✅ *Same form, two outcomes, decided only after the code is verified.*

---

## 3. The nav swap and `/my-bookings`

| State | Nav entry | Right side | `/my-bookings` |
|---|---|---|---|
| Signed out | Bookings | language toggle + **Sign in** | reference form + Sign in link |
| Signed in | **Profile** | language toggle only | **redirects to `/account`** |

Check this on a page from each family, because they render the header
differently: `/` (server component), `/booking` (client), `/gift-card` (client).
Then check the **mobile** panel — shrink the window below `lg`, open the
hamburger: the nav list has the same swap, and the action row carries Sign in
only when signed out.

Switch to English and back — both languages, both states.

Finally, while signed in, type `/my-bookings` into the address bar → you are
redirected to `/account`. Sign out → it renders normally again.

---

## 4. Earning points

1. Signed in, book something and pay (`/booking` → pick → `/booking/payment`).
2. Back on `/account`: the wallet shows one point per 5 SAR paid
   (`loyalty_sar_per_point` defaults to `5`), and the booking appears in **Your
   bookings** — **without you typing a reference anywhere.**

**Try the flooring:** a 9.99 SAR bill must earn **1** point, not 2. Points are
money; rounding up is a mint anyone can run by splitting a bill.

**Never fractional.** If you ever see `12.5 points` on screen or a non-integer
in `loyalty_txns.delta_points`, something has gone badly wrong in
`pointsEarned` — that is the one thing `npm run check:loyalty` sweeps a whole
range of bills and divisors for.

**Earned on what you paid.** Redeem a reward, pay, and the points earned should
match the *discounted* total, not the original — otherwise a discount would
partly pay for itself.

**Group booking:** book two guests on one bill. Exactly **one** ledger row is
written, for the whole bill — not one per guest.

---

## 5. Spending points

Give yourself a balance if you don't want to book three times:

```sql
insert into loyalty_txns (customer_id, delta_points, reason)
values ('<your-customer-id>', 300, 'manual test');
```

*(A row with no `booking_id` always counts — there is no booking whose death
could take it away.)*

1. `/account` → the ladder now shows **100** and **200** as *Available now*, and
   **300** as *Available now* too at a balance of 300. Drop the grant to 250 to
   see a locked rung with its "50 more points" countdown.
2. Start a booking. On `/booking/payment`, below the discount-code field, there
   is a **Spend points** block showing your balance, the three rungs, and a
   **Don't spend points** option selected by default.
   ✅ *Opt-in. Nothing is spent unless you tick a rung.*
3. A locked rung is visibly disabled and says how many more points you need.
   Try to click it — nothing happens.
4. Tick **200 points — 10% off**. The summary grows a discount line reading
   *"10% off for 200 points"*, and the big total drops by exactly 10%.
5. **Stack it with a code.** Type a valid promo code and apply it. The reward
   line **re-quotes itself** — 10% of the *post-promo* total, not the original.
   ✅ *This is the ordering that matters: group/refill → promo → reward.*
   Remove the code; the reward re-quotes upward again.
6. Pay. On `/account` afterwards, the ledger has a `-200` row against that
   booking **and** a positive row for the points that booking earned — the net
   change is less than 200, because spending points still earns points.

**Signed out**, the whole Spend points block is **absent** from checkout — an
account is optional and guest checkout must never grow a sign-in wall.

---

## 6. Getting points back — the important part

There is **no code anywhere that refunds points.** The balance simply stops
counting a redemption whose booking died. So each of these must work, and if any
of them doesn't, the filter is wrong — not the refund path, because there isn't
one.

### 6a. Cancellation

Spend 200 on a booking, then cancel it from `/account`.
**Expect:** the 200 are back immediately — **and** the points that booking
earned are gone, because both rows hang off the same booking.

### 6b. Declined payment — two halves, both matter

`confirmBookingPayment` takes a dev-only `simulate: "decline"`
([`lib/payments/confirm.ts`](../lib/payments/confirm.ts)). Trigger a decline on
a booking with a reward ticked.

**Immediately after the decline:**
- the balance still shows the points as spent;
- **retrying the payment keeps the same discount** — same booking, same debit,
  no re-pricing. ✅ *This is correct, not a leak.*

**After the hold window lapses** — and this is the subtle one:
- the points are spendable again,
- **without anyone else having booked** to trigger the sweep.

To test in under a minute rather than fifteen, drop the window first:

```sql
update settings set value = '1' where key = 'booking_hold_min';
-- ...decline, wait ~70 seconds, reload /account...
update settings set value = '15' where key = 'booking_hold_min';
```

If the points only come back after you book something else in another browser,
the clock clause has been lost and a real declined payment would lock a
customer's points for hours.

### 6c. Abandoned checkout

Hold a booking with a reward ticked, then close the tab. Past the hold window,
the points are spendable again — same mechanism as 6b.

### 6d. Revocation of earned points

Complete and pay a booking (earning points), then cancel it. The points it
earned are **gone**. A refunded visit should not leave the loyalty behind.

---

## 7. Both languages

`/account` in Arabic and English, in all three states (email, code, profile) and
signed in. Check that the ladder rows, the wallet number and the checkout
reward block all read correctly RTL and LTR, and that the email field, the code
field and the birthday field stay **LTR** in Arabic — a reversed phone number or
date is a different number.

---

## 8. Trying to break it

Everything below should fail. Use devtools' Network → *Copy as fetch* to replay
a request with an edited body.

| Attempt | Expected |
|---|---|
| Add `"customerId": "<someone-else>"` to the `/api/bookings` body | Ignored entirely — the session cookie is the only source. |
| `"redeemPoints": 500` with a balance of 0 | `400`, `error: "reward-invalid"`, `rewardReason: "locked"`. The hold is **refused**, never priced wrong. |
| `"redeemPoints": 300` (between rungs) | `400`, `rewardReason: "unknown"`. |
| `"redeemPoints": -100` | `400 invalid` from the schema. |
| Edit one character of the `ron_account` cookie | Signed out. No error page. |
| **Sign in at `/admin`, copy `authjs.session-token` into `ron_account`** | **Signed out.** Different salt, so it cannot even decrypt. *Do this one — it is the boundary between the two audiences.* |
| The reverse: paste `ron_account` into `authjs.session-token` | `/admin` bounces to the staff login. |
| Post a session token as the signup `ticket` | `401 ticket-expired` — the `signup:` prefix is checked. |
| Wait 16 minutes on the profile form, then submit | `401 ticket-expired`, and you are sent back to the email step. |
| Request codes for ten different addresses quickly | `429` after six. |
| Request two codes for the same address inside a minute | Second returns `throttled: true` and no second email. **Only the newest code works** — try the older one, it is refused. |
| Enter a wrong code six times | Burned after five; you must request a new one. |
| Request a code for an address that has an account, and one that doesn't | **Byte-identical responses.** Compare them in the Network tab. This is the anti-enumeration property. |
| `update customers set blocked = true` mid-session, then reload | Signed out on the next request. |
| Sign up with a phone already tied to a *different* verified email | `409 phone-in-use`. |
| **Two tabs, both holding a booking spending the whole balance** | The second is refused `reward-invalid`. The `SELECT … FOR UPDATE` on the customer row serialises them. |

---

## 9. Nothing else regressed

The OTP table was renamed and its key widened, so re-test the flows that used it:

```bash
npm run check:promo    # pricing unchanged
npm run check:cancel
npm run check:fields
npm run check:loyalty
npm run build
```

And by hand, **signed out**:

1. `/my-bookings` → enter a real reference → the booking appears.
2. Open a refill on it → a code is emailed → the offer unlocks.
   ✅ *This is the path that ran on `booking_otps`; it must still work.*
3. Cancel and reschedule from that screen.
4. A guest checkout end to end, with a promo code, no account involved.

---

## Known ceilings

These are deliberate. Don't file them as bugs without reading §8 of
[`docs/CUSTOMER-ACCOUNTS.md`](./CUSTOMER-ACCOUNTS.md).

- A guest who books under phone A and later signs up with phone B gets two
  customer rows; the older bookings stay off the account.
- The refill dialog still emails a code even to a signed-in customer — those
  routes authenticate on the booking reference.
- Rate limits are in-memory, so they count per serverless instance and reset on
  cold start.
- Signing out does not invalidate a token already captured elsewhere; that is
  what `customers.blocked` and rotating `AUTH_SECRET` are for.
