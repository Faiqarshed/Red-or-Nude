"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Coffee } from "lucide-react";
import { useRouter } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import PaymentMethods from "@/components/PaymentMethods";
import { usePaymentReturn, type PaymentOutcome } from "@/components/StreamPayCheckout";
import PhoneField from "@/components/PhoneField";
import { Riyal, Lock } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import {
  clearBooking,
  emptySelection,
  loadBooking,
  loadCheckout,
  releaseHold,
  saveCheckout,
  type BookingSelection,
} from "@/lib/booking";
import { isValidSaudiMobile, toNationalDigits, toStoredPhone } from "@/lib/phone";
import { pick } from "@/lib/localized";
import {
  pointsEarned,
  redeemable,
  toNextMilestone,
  type LoyaltyRules,
} from "@/lib/rewards";

// Figma: Desktop-2 payment step (276:1902 / 276:6624) + success modal (276:6765).
//
// Two calls, in order:
//   POST /api/bookings         → holds the chair(s), rows written as `pending`
//   POST /api/payments/confirm → opens StreamPay's checkout, embedded on the left
//
// She pays inside that checkout; GET /api/payments/status is what then confirms
// and issues the ticket numbers (see components/StreamPayCheckout.tsx). With the
// fake driver, or nothing to pay, the second call confirms on the spot instead.
//
// Nothing is a booking until the payment is verified. A declined card leaves the
// hold in place so the customer can retry without losing their slot, which is why
// the created code is kept in state between attempts.

type Ticket = {
  code: string;
  ticketNo: string;
  stationLabel: string | null;
  /** Null for a booking further out than today — nobody is assigned yet. */
  technicianName: string | null;
  serviceName: { ar: string; en: string } | null;
  startsAt: string;
  totalHalalas: number;
};

export default function PaymentPage() {
  const { c, lang } = useI18n();
  const p = c.payment;
  const a = c.account;
  const router = useRouter();

  const [booking, setBooking] = useState<BookingSelection>(emptySelection);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  /** Set once the hold exists, so a retry after a decline doesn't re-book. */
  const [heldCode, setHeldCode] = useState<string | null>(null);
  /** The open StreamPay checkout, once Pay has been pressed. */
  const [checkout, setCheckout] = useState<{ ref: string; url: string } | null>(null);
  const [phoneTouched, setPhoneTouched] = useState(false);
  /**
   * The discount code (brief §2.10). `promoApplied` is the code the server
   * accepted, not what is being typed — only an accepted one is sent on, and
   * only an accepted one shows a discount row.
   */
  const [promoInput, setPromoInput] = useState("");
  const [promoApplied, setPromoApplied] = useState<string | null>(null);
  const [promoDiscountSar, setPromoDiscountSar] = useState(0);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [promoChecking, setPromoChecking] = useState(false);
  /**
   * The loyalty wallet (brief §2.8). Opt-in: nothing is spent unless a rung is
   * picked, the same way nothing is discounted unless a code is typed.
   *
   * `redeemPoints` is the rung the *server* accepted, not the one clicked — a
   * refused rung clears back to null so the summary can never show a discount
   * the charge won't honour.
   */
  /** The balance, or null when signed out — which is when the picker is hidden. */
  const [balance, setBalance] = useState<number | null>(null);
  /** The scheme's four numbers, from /api/loyalty/quote — see lib/rewards.ts. */
  const [rules, setRules] = useState<LoyaltyRules | null>(null);
  /** Null until the session has answered. True once her details are her own. */
  const [signedIn, setSignedIn] = useState(false);
  const [redeemPoints, setRedeemPoints] = useState<number | null>(null);
  const [redeemDiscountSar, setRedeemDiscountSar] = useState(0);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  /**
   * Checkout upsells taken, as `"<member index>:<add-on id>"` — one guest can
   * take the coffee and another skip it. Nothing new is priced here: the ids go
   * onto that guest's `addonIds` and the server bills them like any add-on.
   */
  const [treats, setTreats] = useState<string[]>([]);

  /**
   * Her own hold from an earlier visit to this page — a reload, or back and
   * forward again — let go before a new one is made. Awaited by confirm(), so
   * the old hold cannot refuse the new one for the very same chair.
   */
  const released = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    released.current = releaseHold();
    const saved = loadBooking();
    if (saved) setBooking(saved);
    setLoaded(true);
  }, []);

  // What she chose here last time — a treat, a code, a reward — so going back to
  // change a service does not quietly drop them. The code and the reward are
  // quoted again rather than trusted: the bill they apply to may have changed.
  useEffect(() => {
    if (!loaded) return;
    const saved = loadCheckout();
    if (!saved) return;
    setTreats(saved.treats.filter((key) => Number(key.split(":")[0]) < booking.members.length));
    if (saved.promo) {
      setPromoInput(saved.promo);
      void applyPromo(saved.promo);
    }
    if (saved.redeemPoints !== null) void pickReward(saved.redeemPoints);
    // Once, when the selection has loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Who she is, if the cookie knows. Everything the form below asks for is
  // already on her account, so it is filled in rather than asked for — the
  // session proved it, and typing it again proves nothing.
  //
  // A guest gets `{ signedIn: false }` and the form as it always was: an account
  // is optional at this checkout and must stay that way (brief §2.8).
  useEffect(() => {
    void fetch("/api/account/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.signedIn) return;
        setSignedIn(true);
        setName(d.name ?? "");
        setPhone(toNationalDigits(d.phone ?? ""));
        setEmail(d.email ?? "");
      })
      .catch(() => {
        /* a prefill, never a gate — the form still works typed out */
      });
  }, []);

  // The rules and the balance. Signed out this comes back with `signedIn:
  // false` and the picker simply never renders — an account is optional, and a
  // guest checkout must not grow a sign-in wall (brief §2.8).
  //
  // The rules come back either way: they are the salon's offer, not the
  // customer's data, and they used to be a module constant imported straight
  // into this file. They moved into `settings` so the salon can retune them
  // without a deploy, so now they arrive over the wire — but the functions that
  // price them are still imported from lib/rewards.ts, which is what keeps this
  // screen and the booking write computing the same figure.
  useEffect(() => {
    void fetch("/api/loyalty/quote")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.rules) setRules(d.rules);
        if (d?.signedIn) setBalance(d.balance);
      })
      .catch(() => {
        /* the wallet is an extra; a checkout must still work without it */
      });
  }, []);

  // A direct visit with nothing selected has nothing to pay for.
  // The booking pages save as she goes, so what arrives can be half-picked. The
  // party's time is only filled in once every guest has one of her own.
  const hasSelection =
    booking.members.length > 0 &&
    booking.startsAt !== null &&
    booking.members.every((m) => m.serviceId);

  // The invoice is emailed the moment the charge clears, so an address is as
  // required as the phone number. Kept loose on purpose — the server's zod
  // schema is the real check, and a strict regex here only ever rejects
  // addresses that are actually valid.
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const phoneOk = isValidSaudiMobile(phone);

  /** The upsells this guest has taken. */
  const treatsFor = (i: number) =>
    (booking.checkoutAddons ?? []).filter((a) => treats.includes(`${i}:${a.id}`));

  /**
   * What the treats add. Outside the discount stack entirely — a coffee is 10
   * SAR whether or not two people booked together, whether or not a code was
   * typed, whether or not points were spent. lib/bookings.ts holds them out of
   * `grossHalalas` for the same reason and adds them back last.
   *
   * So this leaves booking.total alone, and the promo and the reward below stay
   * quoted against a figure ticking a checkbox cannot move.
   */
  const treatsTotal = booking.members.reduce(
    (sum, _m, i) => sum + treatsFor(i).reduce((s, a) => s + a.price, 0),
    0,
  );

  /**
   * What the customer actually pays: the quoted bill, less the code, less the
   * reward. In that order, matching lib/bookings.ts exactly — the reward is
   * quoted against the post-promo figure there, so quoting it against anything
   * else here would show a number the charge disagrees with. Then the treats,
   * which no discount touches.
   */
  const payableTotal = booking.total - promoDiscountSar - redeemDiscountSar + treatsTotal;

  /**
   * What her memberships took off, across the party.
   *
   * `booking.total` already has this deducted — the booking screen subtracts it
   * before saving — so this is carried alongside purely so the bill can show the
   * subtraction. Added back onto the subtotal below and taken off again as its
   * own line, which is the only way the arithmetic on screen reads as
   * arithmetic instead of a number that is mysteriously already small.
   */
  const creditTotal = booking.members.reduce((sum, m) => sum + (m.creditSar ?? 0), 0);

  /** The membership lines, for the panel that says how this is being paid. */
  const covered = booking.members.filter((m) => (m.creditSar ?? 0) > 0);

  /**
   * A membership credit — or a full reward, or a 100% code — has covered it.
   *
   * Everything about this screen that asks for money then goes away: the card
   * form, the methods, the padlock, the word "payment". Asking a customer to
   * enter a card to be charged nothing is a step that exists only because the
   * code could not tell the difference, and she notices before the code does.
   *
   * The screen stays. She is still choosing to spend a credit and commit to an
   * hour, and a booking that fires off the previous page with no review is not a
   * shortcut, it is a surprise. It is one button now, and none of it is a till.
   */
  const nothingToPay = payableTotal <= 0;

  /**
   * The appointment itself is already paid for — by a membership credit.
   *
   * Distinct from `nothingToPay`, which a coffee undoes. This is about the bill
   * the discounts apply to: with the service line already at zero there is
   * nothing for a promo code to take a percentage of and nothing for points to
   * come off, so offering either is offering the customer a choice between
   * nothing and nothing. (Points are a fixed riyal amount now rather than a
   * percentage, and rewardDiscount caps them at the bill — so spending them
   * here would burn the balance for no discount at all, which is worse than
   * offering nothing.) Treats sit outside the discount stack entirely (see
   * treatsTotal), so adding one brings the card form back without bringing
   * these back.
   */
  const fullyCovered = booking.total <= 0;

  /** The card itself is StreamPay's to check; ours are the contact details. */
  const readyToConfirm = phoneOk && emailOk && checkout === null;

  const promoReasonText = (reason: string, minTotalHalalas?: number): string => {
    const e = p.promoErrors;
    switch (reason) {
      case "min-total":
        return e.minTotal.replace("{n}", String(Math.ceil((minTotalHalalas ?? 0) / 100)));
      case "expired":
        return e.expired;
      case "not-started":
        return e.notStarted;
      case "used-up":
        return e.usedUp;
      // "inactive" is a code the salon switched off. To the customer that is
      // indistinguishable from one that never existed, and saying so would tell
      // a stranger which of their guesses are real codes.
      default:
        return e.unknown;
    }
  };

  const applyPromo = async (typed = promoInput) => {
    const code = typed.trim();
    if (!code || promoChecking) return;
    setPromoChecking(true);
    setPromoError(null);

    try {
      const res = await fetch("/api/promo/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Display only — /api/bookings re-prices the code against totals it
        // works out from the catalogue itself, and that is what gets charged.
        body: JSON.stringify({ code, totalHalalas: Math.round(booking.total * 100) }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 429) {
        setPromoError(p.promoErrors.tooMany);
        return;
      }
      if (!res.ok || !data.ok) {
        setPromoApplied(null);
        setPromoDiscountSar(0);
        setPromoError(promoReasonText(data.reason ?? "unknown", data.minTotalHalalas));
        return;
      }

      setPromoApplied(data.code);
      setPromoDiscountSar(data.discountHalalas / 100);
    } catch {
      setPromoError(p.promoErrors.unknown);
    } finally {
      setPromoChecking(false);
    }
  };

  const clearPromo = () => {
    setPromoApplied(null);
    setPromoDiscountSar(0);
    setPromoError(null);
    setPromoInput("");
  };

  /**
   * Pick a rung, or unpick one.
   *
   * Re-quoted server-side on every click rather than computed here: the balance
   * can have moved since the page loaded, and the percentage applies to the
   * post-promo total which changes when a code is applied or removed.
   */
  const pickReward = async (points: number | null) => {
    setRedeemError(null);
    if (points === null) {
      setRedeemPoints(null);
      setRedeemDiscountSar(0);
      return;
    }
    try {
      const res = await fetch("/api/loyalty/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          points,
          // The bill after the code, which is what the server prices against.
          totalHalalas: Math.round((booking.total - promoDiscountSar) * 100),
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.ok) {
        setRedeemPoints(null);
        setRedeemDiscountSar(0);
        setRedeemError(rewardReasonText(res.status === 401 ? "signed-out" : data.reason));
        // The refusal carries the real balance, so a stale ladder corrects
        // itself instead of offering the same rung again.
        if (typeof data.balance === "number") setBalance(data.balance);
        return;
      }

      setRedeemPoints(data.points);
      setRedeemDiscountSar(data.discountHalalas / 100);
    } catch {
      setRedeemError(a.redeemErrors.unknown);
    }
  };

  // What the picked reward is worth, in riyals. Derived from the discount the
  // server quoted rather than recomputed here, so a reward capped by a small
  // bill reads as what actually came off it.
  const redeemValueSar = redeemDiscountSar;

  const rewardReasonText = (reason: string): string => {
    const e = a.redeemErrors;
    if (reason === "locked") return e.locked;
    if (reason === "signed-out") return e.signedOut;
    return e.unknown;
  };

  // A code applied or removed moves the total the percentage applies to, so a
  // reward picked before it is now priced against the wrong number. Re-quoting
  // is one request and keeps the summary honest. Treats are deliberately not a
  // dependency: no discount applies to them, so ticking one moves nothing here.
  useEffect(() => {
    if (redeemPoints !== null) void pickReward(redeemPoints);
    // Intentionally keyed on the base total only: re-running on redeemPoints
    // would loop, since pickReward sets it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promoDiscountSar, booking.total]);

  useEffect(() => {
    if (!loaded) return;
    saveCheckout({
      treats,
      promo: promoApplied,
      redeemPoints,
      held: heldCode ? { code: heldCode, email: email.trim() } : null,
    });
    // `email` is read only alongside a new hold; typing does not need a write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, treats, promoApplied, redeemPoints, heldCode]);

  const confirm = async () => {
    if (!hasSelection || submitting) return;
    // Guarded here as well as on the disabled prop: Enter in a field can still
    // reach this.
    if (!emailOk) {
      setError(p.invalidEmail);
      return;
    }
    setError(null);
    setSubmitting(true);

    try {
      // Step 1 — hold the chairs, unless a previous attempt already did.
      let code = heldCode;
      if (!code) {
        await released.current;
        const res = await fetch("/api/bookings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            branchId: booking.branchId,
            startsAt: booking.startsAt,
            members: booking.members.map((m, i) => ({
              guestName: m.guestName,
              serviceId: m.serviceId,
              // Hers when she picked her own, otherwise the party's. The server
              // holds every guest to the party's day either way.
              branchId: m.branchId ?? null,
              startsAt: m.startsAt ?? null,
              // Which purchase, not whose — the server reads the owner from the
              // session cookie and re-checks the credit against her ledger.
              customerPackId: m.customerPackId ?? null,
              // The coffee rides the add-on machinery: nothing here prices it.
              addonIds: [...m.addonIds, ...treatsFor(i).map((a) => a.id)],
              removalTypeId: m.removalTypeId,
              designId: m.designId,
            })),
            customer: {
              name: name.trim() || undefined,
              phone: toStoredPhone(phone),
              email: email.trim(),
              lang,
            },
            refillOfCode: booking.refillOf ?? null,
            stationToken: booking.stationToken ?? null,
            promoCode: promoApplied,
            // Which rung, not whose points — the server reads that from the
            // session cookie. See app/api/bookings/route.ts.
            redeemPoints,
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          // 409 means the thing they were looking at is gone: either someone
          // took the chair while they typed, or the refill window just lapsed.
          // `refill-not-yours` reads the same to her: the offer is not one this
          // checkout can use. It is a different reason on the server, and the
          // difference is not hers to learn — it would say whose booking it is.
          if (data.error === "refill-expired" || data.error === "refill-not-yours") {
            setError(p.refillExpired);
          }
          else if (data.error === "refill-window") setError(p.refillWindow);
          // The code was fine when it was previewed and is not any more, or the
          // preview was lying. Either way the hold was refused rather than
          // charged at full price — clear it and say why.
          else if (data.error === "promo-invalid") {
            setPromoApplied(null);
            setPromoDiscountSar(0);
            setPromoError(promoReasonText(data.promoReason ?? "unknown", data.minTotalHalalas));
            setError(p.promoRejected);
          }
          // Same shape as a refused code: the hold was refused rather than
          // charged at the wrong price, so clear the reward and say why.
          else if (data.error === "reward-invalid") {
            setRedeemPoints(null);
            setRedeemDiscountSar(0);
            setRedeemError(rewardReasonText(data.rewardReason ?? "unknown"));
            if (typeof data.pointsBalance === "number") setBalance(data.pointsBalance);
            setError(p.promoRejected);
          }
          // Name her. The party is refused as a whole — that part is right —
          // but with four guests at four hours, "that time has gone" does not
          // say which one to change. Falls back to the unnamed line for a solo
          // booking, where there is only one time it could be.
          else if (res.status === 409) {
            const at = data.guestIndex;
            const who =
              typeof at === "number" && booking.members.length > 1
                ? booking.members[at]?.guestName ||
                  c.booking.guestN.replace("{n}", String(at + 1))
                : null;
            setError(who ? p.slotTakenGuest.replace("{name}", who) : p.slotTaken);
          }
          else if (data.error === "invalid" && data.issues?.includes("customer.phone")) {
            setError(p.invalidPhone);
          } else if (data.error === "invalid" && data.issues?.includes("customer.email")) {
            setError(p.invalidEmail);
          } else setError(p.bookingFailed);
          return;
        }

        code = (await res.json()).bookings[0].code as string;
        setHeldCode(code);
      }

      // Step 2 — the checkout. Only a verified payment confirms anything.
      const pay = await fetch("/api/payments/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });

      const data = await pay.json().catch(() => ({}));
      if (pay.ok && data.checkout) {
        setCheckout(data.checkout);
        return;
      }
      if (pay.ok) {
        setTickets(data.tickets);
        clearBooking();
        return;
      }
      showPayError(data.error);
    } catch {
      setError(p.bookingFailed);
    } finally {
      setSubmitting(false);
    }
  };

  const showPayError = (code: string | undefined) => {
    if (code === "payment-declined") setError(p.declined);
    else if (code === "expired") {
      // The hold is gone; a retry would confirm nothing, so send them back.
      setHeldCode(null);
      setError(p.expired);
    } else if (code === "unconfirmed" || code === "in-progress") setError(p.unconfirmed);
    else setError(p.bookingFailed);
  };

  /** The embedded checkout ended — or she came back from the hosted one. */
  const onPaid = (outcome: PaymentOutcome) => {
    setCheckout(null);
    if (outcome.status === "paid" && outcome.result.kind === "booking") {
      setTickets(outcome.result.tickets as Ticket[]);
      clearBooking();
      return;
    }
    showPayError(outcome.status === "failed" ? outcome.error : undefined);
  };
  usePaymentReturn(onPaid);

  return (
    <main className="relative min-h-screen bg-cream">
      <SiteHeader />

      {/* One layout, whatever the bill says.

          The grid used to collapse to a single column the moment a credit
          covered everything, and spring back to two the moment a 10 SAR coffee
          was ticked. Adding a treat is a small decision and it was rearranging
          the whole screen — which reads as something going wrong, not as ten
          riyals being added. The columns stay; what changes is a number. */}
      <div className="mx-auto grid max-w-page gap-8 px-6 pb-24 pt-[120px] md:px-12 lg:grid-cols-[1fr_540px] lg:px-16">
        <div className="space-y-5">
          <h1 className="text-start font-display text-2xl font-extrabold text-ink">{p.payWith}</h1>

          {/* What the membership is covering, said before any card is asked
              for. She is not paying for the service out of her own pocket, and
              a screen that leads with a card form implies she is. */}
          {covered.length > 0 && (
            <section className="rounded-[20px] bg-[#f2f7f2] p-5 text-start ring-1 ring-[#2f6b3f]/15">
              <p className="font-display text-base font-extrabold text-[#2f6b3f]">
                {p.coveredTitle}
              </p>
              <ul className="mt-3 space-y-1.5">
                {covered.map((m, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="truncate text-ink/70">
                      {p.coveredService
                        .replace("{service}", m.service ?? "")
                        .replace("{pack}", m.packName ?? "")}
                    </span>
                    <span className="flex shrink-0 items-center gap-1 font-semibold text-[#2f6b3f]">
                      −<Riyal className="h-3 w-3" />
                      {m.creditSar}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[12px] text-ink/50">{p.coveredNote}</p>
            </section>
          )}

          {/* The card, for whatever the membership did not cover. Mounted only
              when there is something to take, but in the slot it always
              occupies, under the panel above rather than in place of it. */}
          {nothingToPay ? (
            <section className="rounded-[20px] bg-white p-5 text-start ring-1 ring-black/[0.04]">
              <p className="text-sm font-semibold text-ink/70">{p.nothingLeft}</p>
            </section>
          ) : (
            <>
              {covered.length > 0 && (
                <p className="text-start text-[12px] text-ink/50">{p.remainderNote}</p>
              )}
              <PaymentMethods checkout={checkout} onDone={onPaid} />
            </>
          )}

          {/* What this booking EARNS, as against what it can spend.
              
              The gamified half of the scheme, and it lives here rather than on
              /account because accrual is per bill: "add 24 riyals and you earn
              50 points" is a fact about the basket in front of her, and this is
              the only screen where she can act on it. The account page shows a
              balance, because that is all a balance can honestly show.
              
              Shown to guests too — it is the reason to make an account, and the
              one place the offer is worth stating is where the money is. */}
          {rules !== null && payableTotal > 0 && (() => {
            const paidHalalas = Math.round(payableTotal * 100);
            const earned = pointsEarned(paidHalalas, rules);
            const gapHalalas = toNextMilestone(paidHalalas, rules);
            const gapSar = gapHalalas / 100;
            const stepValueSar = (rules.stepPoints * rules.pointHalalas) / 100;
            const earnedValueSar = (earned * rules.pointHalalas) / 100;
            // How far through the current span she is, as a bar. Unlike a tier
            // track this only ever measures the bill on screen, so it cannot
            // slide backwards when she spends the points it earned her.
            //
            // The span is the FIRST milestone until one is reached and a step
            // after that — 199 then 200 — because the first award is nearer
            // than the ones that follow, and a bar measured against 200
            // throughout would understate how close a new customer is.
            const spanHalalas = (earned === 0 ? rules.firstSar : rules.stepSar) * 100;
            const pct = Math.max(
              2,
              Math.min(100, Math.round(((spanHalalas - gapHalalas) / spanHalalas) * 100)),
            );

            return (
              <section className="rounded-[20px] bg-white p-5 text-start ring-1 ring-black/[0.04]">
                <span className="font-display text-base font-extrabold text-ink">{a.earnTitle}</span>

                <div className="relative mt-3.5 h-2.5 rounded-full bg-black/[0.07]">
                  <div
                    className="absolute inset-y-0 rounded-full bg-red-grad transition-[width] duration-700 ease-out"
                    style={{ insetInlineStart: 0, width: `${pct}%` }}
                  />
                </div>

                <p className="mt-2.5 text-[13px] font-semibold text-ink">
                  {earned > 0
                    ? a.earnReached
                        .replace("{points}", String(earned))
                        .replace("{value}", String(earnedValueSar))
                    : a.earnAlmost
                        .replace("{sar}", String(gapSar))
                        .replace("{points}", String(rules.stepPoints))
                        .replace("{value}", String(stepValueSar))}
                </p>

                {/* Already over a milestone: name the next one too, so a bill
                    sitting just under the following threshold still says so. */}
                {earned > 0 && (
                  <p className="mt-1 text-[12px] text-ink/55">
                    {a.earnMore
                      .replace("{sar}", String(gapSar))
                      .replace("{points}", String(rules.stepPoints))}
                  </p>
                )}

                {/* Currency, not status. Said plainly because the bar above is
                    the shape people read as a tier. */}
                <p className="mt-2.5 text-[11px] text-ink/45">{a.earnNote}</p>
              </section>
            );
          })()}

          {/* The loyalty ladder (brief §2.8), beside how she is paying rather
              than in the summary: it is a way of paying, and three locked rows
              made the summary column twice the length of this one.

              Outside the card-form branch above on purpose. A rung big enough
              to clear the bill hides the card form, and the way to un-pick that
              rung must not go with it.

              Only the rungs she can afford, and nothing at all when that is
              none — a checkout is where points are spent, not where she is told
              how far off she is; /account shows the whole ladder for that. Kept
              while a refusal is on screen, or its message would vanish with the
              rung it was about.

              Signed-in only — an account is optional and a guest checkout must
              never grow a sign-in wall. Hidden on a bill a membership already
              cleared, for the reason the promo field is: there is nothing left
              to take a percentage of. */}
          {(() => {
            if (balance === null || rules === null || fullyCovered) return null;
            // Bounded by the bill as well as the balance: offering 150 points
            // against a 20 riyal bill is offering to burn 30 riyals of reward
            // for 20 riyals off.
            const affordable = redeemable(
              balance,
              Math.round((booking.total - promoDiscountSar) * 100),
              rules,
            );
            if (affordable.length === 0 && !redeemError) return null;
            return (
              <section className="rounded-[20px] bg-white p-5 text-start ring-1 ring-black/[0.04]">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <span className="font-display text-base font-extrabold text-ink">{a.redeemLabel}</span>
                  <span className="text-[12px] font-semibold text-red">
                    {a.redeemBalance.replace("{n}", String(balance))}
                  </span>
                </div>

                <div className="space-y-1.5">
                  {affordable.map((points) => {
                    const picked = redeemPoints === points;
                    return (
                      <label
                        key={points}
                        className={`flex cursor-pointer items-center gap-2.5 rounded-[12px] border px-4 py-3 text-[13px] ${
                          picked
                            ? "border-red/40 bg-red/[0.04] text-red"
                            : "border-black/[0.08] text-ink hover:border-red/30"
                        }`}
                      >
                        <input
                          type="radio"
                          name="reward"
                          checked={picked}
                          onChange={() => void pickReward(points)}
                          className="accent-red"
                        />
                        <span className="font-semibold">
                          {a.rewardRow
                            .replace("{points}", String(points))
                            .replace("{sar}", String((points * rules.pointHalalas) / 100))}
                        </span>
                      </label>
                    );
                  })}

                  {/* Opt out explicitly. Without this row the only way to
                      un-pick a radio is to reload the page. */}
                  <label className="flex cursor-pointer items-center gap-2.5 px-4 py-1.5 text-[12px] text-ink/45">
                    <input
                      type="radio"
                      name="reward"
                      checked={redeemPoints === null}
                      onChange={() => void pickReward(null)}
                      className="accent-red"
                    />
                    {a.redeemNone}
                  </label>
                </div>

                {redeemError && (
                  <p role="alert" className="mt-1.5 text-[11px] text-red">
                    {redeemError}
                  </p>
                )}
              </section>
            );
          })()}
        </div>

        {/* Summary */}
        <aside className="h-fit rounded-[24px] bg-white p-6 text-start shadow-[0_20px_50px_rgba(184,0,7,0.06)]">
          <h2 className="mb-5 text-center font-display text-2xl font-extrabold text-ink">
            {p.summaryTitle}
          </h2>

          {loaded && !hasSelection ? (
            <div className="rounded-[14px] bg-[#fbeaea] p-5 text-center">
              <p className="text-sm text-ink/70">{p.noSelection}</p>
              <Link
                href="/booking"
                className="mt-3 inline-block rounded-[12px] bg-red-grad px-5 py-2.5 text-sm font-bold text-white"
              >
                {p.newBooking}
              </Link>
            </div>
          ) : (
            <>
              <div className="space-y-4">
                {booking.members.map((m, i) => (
                  <div key={i}>
                    {booking.members.length > 1 && (
                      <p className="mb-2 font-display text-sm font-extrabold text-red">
                        {c.booking.guestN.replace("{n}", String(i + 1))}
                      </p>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <Field label={p.rowService} value={m.service ?? "—"} />
                      <Field
                        label={c.booking.addons}
                        value={m.addons.length ? m.addons.join("، ") : c.booking.none}
                      />
                      <Field label={c.booking.removal} value={m.removal ?? c.booking.none} />
                      {/* Only when she holds her own — a group that picked one
                          branch and one slot together still reads as one
                          appointment, on the row below. */}
                      {m.timeLabel && (
                        <Field
                          label={c.booking.appointment}
                          value={`${m.branch ? `${m.branch} · ` : ""}${m.timeLabel}`}
                        />
                      )}
                      <Field label={c.booking.total} value={String(m.price)} />
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-3">
                <Field
                  label={c.booking.appointment}
                  value={
                    booking.dateLabel && booking.timeLabel
                      ? `${booking.dateLabel} - ${booking.timeLabel}`
                      : c.booking.notSelected
                  }
                />
              </div>

              {/* A booking needs someone to belong to — the picker never asked.
                  Signed in, her account already answered all three, so this
                  collapses to a line saying who the booking is for. She can
                  still change any of it, on /account, where the change sticks
                  instead of applying to one booking and being forgotten. */}
              {signedIn ? (
                <div className="mt-4 rounded-[14px] bg-cream/70 p-4 text-start">
                  <p className="text-[11px] text-ink/45">{p.bookingFor}</p>
                  <p className="mt-0.5 truncate text-sm font-semibold text-ink">
                    {name || email}
                  </p>
                  <p dir="ltr" className="mt-0.5 truncate text-start text-[12px] text-ink/50">
                    {email}
                  </p>
                </div>
              ) : (
              <div className="mt-4 space-y-3">
                <label className="block text-start">
                  <span className="mb-1.5 block text-[12px] text-ink/55">{p.customerName}</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={120}
                    autoComplete="name"
                    className="w-full rounded-[12px] border border-black/[0.08] px-4 py-3 text-sm text-ink outline-none focus:border-red/40"
                  />
                </label>
                <PhoneField
                  label={p.customerPhone}
                  value={phone}
                  onChange={setPhone}
                  required
                  showError={phoneTouched}
                  onBlur={() => setPhoneTouched(true)}
                />
                {/* Required twice over: it carries the booking reference that
                    is the only key to /my-bookings, and it is where the invoice
                    goes the instant the charge clears. */}
                <label className="block text-start">
                  <span className="mb-1.5 block text-[12px] text-ink/55">{p.customerEmail} *</span>
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    dir="ltr"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    maxLength={200}
                    placeholder="sarah@example.com"
                    className="w-full rounded-[12px] border border-black/[0.08] px-4 py-3 text-left text-sm text-ink outline-none placeholder:text-ink/30 focus:border-red/40"
                  />
                  <span className="mt-1.5 block text-[11px] text-ink/40">{p.emailNote}</span>
                </label>
              </div>
              )}

              {/* Occasion discount codes (brief §2.10). Applied before the hold
                  exists, so a code typed after a declined card still counts —
                  the retry re-uses the hold and never re-prices it.

                  Not offered against a bill a membership already cleared: a
                  percentage of zero is zero, and a field that cannot change the
                  total is a field that only wastes the customer's time. */}
              {!fullyCovered && (
              <div className="mt-4">
                <span className="mb-1.5 block text-[12px] text-ink/55">{p.promoLabel}</span>
                {promoApplied ? (
                  <div className="flex items-center justify-between rounded-[12px] border border-red/20 bg-red/[0.04] px-4 py-3">
                    <span className="text-sm font-semibold text-red" dir="ltr">
                      {promoApplied}
                    </span>
                    <button
                      type="button"
                      onClick={clearPromo}
                      className="text-[12px] font-semibold text-ink/50 underline underline-offset-4 hover:text-ink"
                    >
                      {p.promoRemove}
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <input
                      value={promoInput}
                      onChange={(e) => setPromoInput(e.target.value.toUpperCase())}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void applyPromo();
                        }
                      }}
                      dir="ltr"
                      maxLength={40}
                      placeholder={p.promoPlaceholder}
                      className="min-w-0 flex-1 rounded-[12px] border border-black/[0.08] px-4 py-3 text-left text-sm uppercase text-ink outline-none placeholder:normal-case placeholder:text-ink/30 focus:border-red/40"
                    />
                    <button
                      type="button"
                      onClick={() => void applyPromo()}
                      disabled={!promoInput.trim() || promoChecking}
                      className="shrink-0 rounded-[12px] bg-black/[0.06] px-5 text-sm font-bold text-ink transition-colors hover:bg-black/[0.1] disabled:cursor-not-allowed disabled:text-ink/40"
                    >
                      {promoChecking ? p.promoApplying : p.promoApply}
                    </button>
                  </div>
                )}
                {promoError && (
                  <p role="alert" className="mt-1.5 text-[11px] text-red">
                    {promoError}
                  </p>
                )}
              </div>
              )}

              {/* Coffee and a cookie, offered once the services are chosen and
                  before payment — one row per guest, so one can take it and
                  another skip it. Frozen once the chairs are held: the retry
                  after a declined card re-uses that hold and never re-prices
                  it, so a treat added now would be shown and not charged. */}
              {(booking.checkoutAddons?.length ?? 0) > 0 && (
                <div className="mt-4">
                  <span className="mb-1.5 block text-[12px] text-ink/55">{p.treatLabel}</span>
                  <div className="space-y-1.5">
                    {booking.members.map((_, i) =>
                      (booking.checkoutAddons ?? []).map((a) => {
                        const key = `${i}:${a.id}`;
                        const taken = treats.includes(key);
                        return (
                          <label
                            key={key}
                            className={`flex items-center gap-3 rounded-[12px] border p-2.5 pe-4 text-[13px] ${
                              taken
                                ? "border-red/40 bg-red/[0.04] text-red"
                                : heldCode
                                  ? "cursor-not-allowed border-black/[0.05] text-ink/35"
                                  : "cursor-pointer border-black/[0.08] text-ink hover:border-red/30"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={taken}
                              disabled={heldCode !== null}
                              onChange={() =>
                                setTreats((prev) =>
                                  prev.includes(key)
                                    ? prev.filter((k) => k !== key)
                                    : [...prev, key],
                                )
                              }
                              className="ms-1.5 h-4 w-4 shrink-0 accent-red"
                            />
                            {/* A picture sells a coffee a line of text does not,
                                so the tile is always there: the salon's photo
                                (Admin → Catalog → the upsell's Image), or a cup
                                on the beige every other image tile waits on —
                                a drawn placeholder, not an empty box that reads
                                as a broken image. */}
                            <span
                              className="grid h-14 w-20 shrink-0 place-items-center rounded-[10px] bg-[#e7d9c9] bg-cover bg-center bg-no-repeat text-[#8a6a4a]"
                              style={a.img ? { backgroundImage: `url(${a.img})` } : undefined}
                            >
                              {!a.img && <Coffee className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
                            </span>
                            <span className="min-w-0 flex-1 font-semibold">
                              {booking.members.length > 1
                                ? `${c.booking.guestN.replace("{n}", String(i + 1))} — ${pick(a.name, lang)}`
                                : pick(a.name, lang)}
                            </span>
                            <span className="flex shrink-0 items-center gap-1">
                              <Riyal className="h-3 w-3" />
                              {a.price}
                            </span>
                          </label>
                        );
                      }),
                    )}
                  </div>
                </div>
              )}

              {(booking.total < booking.grossTotal ||
                promoDiscountSar > 0 ||
                redeemDiscountSar > 0) && (
                <div className="mt-4 space-y-1.5 rounded-[14px] bg-cream/60 p-4 text-[13px]">
                  <div className="flex items-center justify-between text-ink/55">
                    <span className="flex items-center gap-1">
                      <Riyal className="h-3 w-3" />
                      {/* The credit added back, so the line below can take it
                          away. `grossTotal` arrives already reduced. */}
                      {booking.grossTotal + creditTotal}
                    </span>
                    <span>{p.subtotal}</span>
                  </div>
                  {creditTotal > 0 && (
                    <div className="flex items-center justify-between font-semibold text-[#2f6b3f]">
                      <span className="flex items-center gap-1">
                        −<Riyal className="h-3 w-3" />
                        {creditTotal}
                      </span>
                      <span>{p.membershipLine}</span>
                    </div>
                  )}
                  {booking.total < booking.grossTotal && (
                    <div className="flex items-center justify-between font-semibold text-red">
                      <span className="flex items-center gap-1">
                        −<Riyal className="h-3 w-3" />
                        {booking.grossTotal - booking.total}
                      </span>
                      <span>{p.groupDiscount}</span>
                    </div>
                  )}
                  {promoDiscountSar > 0 && (
                    <div className="flex items-center justify-between font-semibold text-red">
                      <span className="flex items-center gap-1">
                        −<Riyal className="h-3 w-3" />
                        {promoDiscountSar}
                      </span>
                      <span dir="ltr">{promoApplied}</span>
                    </div>
                  )}
                  {redeemDiscountSar > 0 && (
                    <div className="flex items-center justify-between font-semibold text-red">
                      <span className="flex items-center gap-1">
                        −<Riyal className="h-3 w-3" />
                        {redeemDiscountSar}
                      </span>
                      <span>
                        {a.redeemApplied
                          .replace("{sar}", String(redeemValueSar))
                          .replace("{points}", String(redeemPoints ?? 0))}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Two lines, always both there once a membership is involved.
                  "Total" alone had to mean her whole appointment one moment and
                  a lone coffee the next, and a bare red 0 in a money box reads
                  as something that failed to load rather than something already
                  settled. Covered says what her membership did; To pay now says
                  what the card is for, and a treat moves that number from 0 to
                  10 without anything else on the screen moving. */}
              {creditTotal > 0 && (
                <div className="mt-4 flex items-center justify-between rounded-[14px] bg-[#f2f7f2] px-4 py-3">
                  <div className="flex items-center gap-1 font-display text-lg font-extrabold text-[#2f6b3f]">
                    <Riyal className="h-4 w-4" />
                    {creditTotal}
                  </div>
                  <p className="text-xs text-ink/45">{p.coveredTitle}</p>
                </div>
              )}

              <div className="mt-2 flex items-center justify-between rounded-[14px] bg-[#fbeaea] p-4">
                <div className="flex items-center gap-1 font-display text-2xl font-extrabold text-red">
                  <Riyal className="h-5 w-5" />
                  {payableTotal}
                </div>
                <p className="text-xs text-ink/45">{creditTotal > 0 ? p.toPayNow : p.total}</p>
              </div>

              {error && (
                <p role="alert" className="mt-3 rounded-[12px] bg-red/[0.08] px-4 py-3 text-start text-xs text-red">
                  {error}
                </p>
              )}

              <button
                type="button"
                onClick={confirm}
                disabled={submitting || !readyToConfirm}
                className={`mt-6 block w-full rounded-[12px] py-3.5 text-center text-sm font-bold transition-opacity ${
                  submitting || !readyToConfirm
                    ? "cursor-not-allowed bg-black/[0.06] text-ink/40"
                    : "bg-red-grad text-white hover:opacity-90"
                }`}
              >
                {submitting ? p.confirming : nothingToPay ? p.confirmBooking : p.confirmPay}
              </button>
              {nothingToPay ? (
                // Only when no membership is in play — a full reward, or a 100%
                // code. The panel on the left already says it, at more length,
                // when a credit is what covered the bill.
                creditTotal > 0 ? null : (
                  <p className="mt-3 text-center text-[12px] text-ink/55">{p.nothingToPay}</p>
                )
              ) : (
                <>
                  <p className="mt-3 text-center text-[11px] text-ink/40">{p.payFirstNote}</p>
                  <p className="mt-2 flex items-center justify-center gap-1.5 text-[12px] text-ink/45">
                    <Lock className="h-3.5 w-3.5" />
                    {p.secure}
                  </p>
                </>
              )}
            </>
          )}
        </aside>
      </div>

      <SiteFooter />

      {tickets && (
        <SuccessModal tickets={tickets} booking={booking} onClose={() => router.replace("/")} />
      )}
    </main>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[14px] border border-black/[0.05] p-4">
      <p className="mb-1 text-[11px] text-ink/45">{label}</p>
      <p className="text-sm font-semibold text-ink">{value}</p>
    </div>
  );
}

function SuccessModal({
  tickets,
  booking,
  onClose,
}: {
  tickets: Ticket[];
  booking: BookingSelection;
  onClose: () => void;
}) {
  const { c, lang } = useI18n();
  const p = c.payment;

  // Nothing to hunt for. The booking is paid and this screen has no decision
  // left on it, so anywhere outside the card leaves, and so does Escape — both
  // land on the home page rather than on the checkout she has just finished.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="presentation"
      onClick={onClose}
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/30 px-4 py-10 backdrop-blur-sm"
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[460px] rounded-[24px] bg-white p-8 text-center shadow-[0_40px_100px_rgba(0,0,0,0.25)]"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/pay/success-check.webp" alt="" className="mx-auto mb-5 h-20 w-20" />
        <h3 className="font-display text-2xl font-extrabold text-ink">{p.successTitle}</h3>
        <p className="mx-auto mt-2 max-w-[320px] text-sm text-ink/55">{p.successSub}</p>

        {/* The number the salon calls out, and the chair it belongs to. One block
            per guest — a pair gets consecutive numbers on different chairs. */}
        <div className="mt-6 space-y-3">
          {tickets.map((t) => (
            <div key={t.code} className="rounded-[18px] bg-[#fbeaea] p-5">
              <p className="text-[11px] uppercase tracking-wider text-red/60">{p.ticketLabel}</p>
              <p className="font-display text-4xl font-extrabold tracking-wider text-red" dir="ltr">
                {t.ticketNo}
              </p>
              <div className="mt-3 flex items-center justify-center gap-4 text-[13px]">
                <span className="text-ink/55">
                  {p.stationLabel}{" "}
                  <span className="font-bold text-ink" dir="ltr">
                    {t.stationLabel ?? "—"}
                  </span>
                </span>
                {t.serviceName && (
                  <span className="font-semibold text-ink">{t.serviceName[lang]}</span>
                )}
                {/* Only when there is one. A booking further out has no
                    technician yet — the morning run assigns on the day — and
                    an empty label would read as one nobody turned up for. */}
                {t.technicianName && (
                  <span className="text-ink/55">
                    {p.technicianLabel}{" "}
                    <span className="font-bold text-ink">{t.technicianName}</span>
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 rounded-[16px] bg-[#f6f6f6] p-5 text-start">
          <p className="mb-3 font-display text-base font-extrabold text-red">{p.detailsTitle}</p>
          <div className="divide-y divide-black/[0.06]">
            {[
              { label: p.rowDate, value: booking.dateLabel ?? "—" },
              { label: p.rowTime, value: booking.timeLabel ?? "—" },
            ].map((r) => (
              <div key={r.label} className="flex items-center justify-between py-2.5">
                <span className="text-[13px] text-ink/50">{r.label}</span>
                <span className="text-[13px] font-semibold text-ink">{r.value}</span>
              </div>
            ))}
            <div className="flex items-center justify-between py-2.5">
              <span className="text-[13px] text-ink/50">{p.rowTotal}</span>
              <span className="flex items-center gap-1 font-display text-base font-extrabold text-red">
                <Riyal className="h-4 w-4" />
                {/* Summed from the tickets, not from the selection: this is what
                    the card was actually charged, discounts and all. */}
                {tickets.reduce((sum, t) => sum + t.totalHalalas, 0) / 100}
              </span>
            </div>
          </div>
        </div>

        <div className="mt-6 flex gap-3">
          <Link
            href="/booking"
            replace
            className="flex-1 rounded-[12px] bg-black/[0.05] py-3.5 text-center text-sm font-bold text-ink transition-colors hover:bg-black/[0.08]"
          >
            {p.newBooking}
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-[12px] bg-red-grad py-3.5 text-center text-sm font-bold text-white transition-opacity hover:opacity-90"
          >
            {p.close}
          </button>
        </div>

        {/* The reference goes out by email only — nothing here to memorise. */}
        <Link
          href="/my-bookings"
          className="mt-4 inline-block text-[12px] font-semibold text-red underline underline-offset-4"
        >
          {p.myBookings}
        </Link>
      </div>
    </div>
  );
}
