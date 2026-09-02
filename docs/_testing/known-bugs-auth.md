# Known bugs — auth and accounts

Found by `tests/auth/`. Nothing here has been fixed: the skill's rule is that a
test which finds a real bug is reported, not quietly edited to pass, and not
patched in the same change that found it.

---

## BUG-AUTH-001 — account takeover via the register route  ·  **P0**

**Where** `app/api/account/register/route.ts:74-101`
**Test** `tests/auth/accounts.test.ts` — "refuses a phone whose row already has a
different verified address" (`it.fails`), with the current behaviour pinned by
"today, that same request takes the account over".

### The attack

1. The attacker proves an inbox they own — `attacker@example.test` — through the
   ordinary OTP flow, and gets a 15-minute signup ticket.
2. They POST to `/api/account/register` with that ticket, any name, and **the
   victim's phone number**. Nothing else.
3. The response is `200 {"ok":true}` and they are handed a session cookie.

The victim's row is now:

| column | before | after |
|---|---|---|
| `name` | Victim | Attacker |
| `email` | victim@example.test | attacker@example.test |
| `email_verified_at` | *(set)* | *(reset to now)* |
| `id` | unchanged | **unchanged** |

Because the id is unchanged, the attacker inherits everything hanging off it:
booking history, the loyalty ledger (`loyalty_txns.customer_id`), saved
birthday, notes. The victim cannot sign in — their address is no longer on any
row — and the OTP route will happily mint them a *new* empty account.

The only secret required is a phone number, which is not a secret.

### Why the existing guard does not fire

The route expects the database to stop this. Its catch block reads:

```ts
} catch (err) {
  // Almost certainly the partial unique index: this phone's row already
  // carries a *different* verified address. One person, one account.
  return NextResponse.json({ error: "phone-in-use" }, { status: 409 });
}
```

`customers_account_email_unique` (`lib/db/schema.ts:361`) is
`unique (lower(email)) where email_verified_at is not null`. It forbids **two
rows** holding the same verified address. It cannot see a **single row's**
address being changed to one nobody else holds — so the `onConflictDoUpdate`
succeeds, nothing throws, and the 409 is unreachable by this path.

The pre-flight check above it (`already-registered`, line 62) asks whether the
*attacker's* address is taken. It never asks what the phone's row already is.

### Note

The upsert-on-phone is deliberate and documented — a guest who booked from a
number keeps their history when they later sign up. That behaviour is right and
is covered by a passing test. What is missing is the case where the row being
claimed **already belongs to a verified account**.

---

## BUG-AUTH-002 — a mistyped phone number is silently truncated  ·  P3

**Where** `lib/phone.ts:29-37`
**Test** `tests/auth/accounts.test.ts` — "silently truncates a phone number with
extra digits on the end" (characterization, passing).

`toNationalDigits` ends with `d.slice(0, NATIONAL_LENGTH)`, and the comment says
trailing digits are "dropped rather than silently reordered". Dropping them is
still silent: `05120000119999` registers as `0512000011` with a `200`, and that
is the number the salon will ring and the OTP will go to. Reordering would be
worse; refusing would be right.

Low severity on its own. It sharpens BUG-AUTH-001, though — an attacker does not
need the victim's number exactly, only a string that truncates to it.

---

## Not bugs, recorded so they are not re-investigated

- **Wrong-code reasons are distinguishable** (`no-code` / `wrong` /
  `too-many-attempts`). Deliberate, and `lib/otp.ts:118` explains why: they are
  distinguishable *to someone who already read the code from the inbox*, which
  is not an enumeration oracle. `/api/account/otp` is the enumeration surface
  and it does answer identically for known and unknown addresses — asserted.
- **A burnt code reports `no-code`, not `too-many-attempts`,** from the sixth
  attempt onward. Burning sets `consumed_at`, and the lookup filters on it, so
  there is no longer a live row to report attempts for. Correct; the test asserts
  the fifth attempt is the one that says `too-many-attempts`.
