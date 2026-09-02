# Known bugs — money

Found by `tests/money/`. Not fixed — reported.

---

## BUG-MONEY-006 — half-halala amounts round inconsistently  ·  P3

**Where** `lib/money.ts:9` — `sarToHalalas = (sar) => Math.round(sar * 100)`
**Test** `tests/money/maths.test.ts` — "round-trips whole halalas exactly, and
loses the half-halala" (characterization, passing).

`sar * 100` lands either side of `.5` depending on the IEEE-754 representation
of `sar`, so neighbouring amounts round in opposite directions with nothing to
distinguish them:

| input | `sar * 100` | result |
|---|---|---|
| 1.005 | 100.49999999999999 | 100 (down) |
| 1.015 | 101.49999999999999 | 101 (down) |
| 1.045 | 104.5 | 105 (up) |
| 10.005 | 1000.5000000000001 | 1001 (up) |

Harmless while every form that reaches it is limited to two decimals, which is
why this is a characterization test and not a failing one. It is reachable from
admin input — `saveService`, `issueGiftCard`, `savePromoCode` all call it on a
`Sar` field — so a three-decimal price typed into the catalog is a halala off in
an unpredictable direction.

The exact fix is `Math.round((sar * 100).toFixed(2) as unknown as number)` or,
better, parsing the decimal string rather than the float. Not applied: it is a
source change, and the money path is not somewhere to make an unrequested one.

---

## Not bugs, recorded so they are not re-investigated

- **There is no webhook, and therefore no signature verification to test.**
  `MOYASAR_WEBHOOK_SECRET` is in `.env.example`, but `lib/payments/index.ts`
  returns `fakeDriver` unconditionally and `docs/PAYMENTS-MOYASAR.md` opens with
  "Nothing here is built yet. This is the plan." The doc is a plan document, not
  a description of current behaviour, so this is not a docs-versus-code
  contradiction. `tests/money/confirm.test.ts` leaves a tripwire asserting the
  driver is still `fake`, so landing a real one has to touch that file.
- **`getDriver()` ignores `PAYMENT_DRIVER`.** Consistent with there being one
  driver; the comment says to branch on it "once there is a second driver". The
  tripwire above covers it.
- **A declined payment deliberately leaves its bookings `pending`** so the
  customer can retry without re-picking a slot. Asserted, including that no
  invoice is sent and no points are awarded on that path.
- **Confirming twice is refused** in sequence and as a race; one `payments` row
  reaches `paid` either way.
- **A group is one gateway transaction** recorded as one row per booking sharing
  a `providerRef`, and the rows sum to the bill.
