"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Coffee, Sparkles } from "lucide-react";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { PayLogos } from "@/components/PaymentMethods";
import { declineMessage, usePaymentReturn, type PaymentOutcome } from "@/components/StreamPayCheckout";
import { CheckingModal, PayNoticeModal, PayStep, Steps } from "@/components/PayFlow";
import PhoneField from "@/components/PhoneField";
import { Riyal, Lock } from "@/components/icons";
import { formatSAR, walletCovers, walletSpendOk } from "@/lib/money";
import { WalletAmount } from "@/components/WalletCredit";
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
import { showPaidOn } from "@/lib/paid-handoff";
import { pick } from "@/lib/localized";
import { pointsEarned, redeemable, type LoyaltyRules } from "@/lib/rewards";
import { noticeOf, type PayNotice } from "@/lib/payments/notice";

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

export default function PaymentPage({ searchParams }: { searchParams: { paid?: string } }) {
  const { c, lang } = useI18n();
  const p = c.payment;
  const a = c.account;

  const [booking, setBooking] = useState<BookingSelection>(emptySelection);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * What became of a payment, said in front of the page (PayNoticeModal) — not
   * at the foot of a summary she has scrolled away from. Kept after the modal
   * closes, above the checkout, so the reason is still there when she retries.
   */
  const [payNotice, setPayNotice] = useState<string | null>(null);
  /** What it means for her money, which titles the modal (lib/payments/notice.ts). */
  const [noticeKind, setNoticeKind] = useState<PayNotice>("declined");
  const [noticeOpen, setNoticeOpen] = useState(false);
  /** Back on a checkout she had open (a reload): said calmly above it, never as a failure. */
  const [resumed, setResumed] = useState(false);
  const notifyPay = (message: string, kind: PayNotice = "declined") => {
    setPayNotice(message);
    setNoticeKind(kind);
    setNoticeOpen(true);
  };
  /** Set once the hold exists, so a retry after a decline doesn't re-book. */
  const [heldCode, setHeldCode] = useState<string | null>(null);
  /** Asking what became of a hold she came back to (see resumeHeld). */
  const [resuming, setResuming] = useState(false);
  /** Opening a new checkout after a declined one, without going back to step 1. */
  const [reopening, setReopening] = useState(false);
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
  /** The session has answered (signed in or not), so the form is filled as it will stay. */
  const [accountChecked, setAccountChecked] = useState(false);
  const [redeemPoints, setRedeemPoints] = useState<number | null>(null);
  const [redeemDiscountSar, setRedeemDiscountSar] = useState(0);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  /**
   * The wallet (docs/WALLET-PLAN.md): her balance when signed in, in halalas,
   * and how much of it she typed to spend. A guest has no wallet here: she
   * spends a gift card she types, sent to the email she books with.
   */
  const [walletAvailable, setWalletAvailable] = useState(0);
  const [walletPick, setWalletPick] = useState({ halalas: 0, ok: true });
  /** Signed in, the gift card field waits behind a link: her cards are already in her wallet. */
  const [giftOpen, setGiftOpen] = useState(false);
  const [giftInput, setGiftInput] = useState("");
  /** A card the server said brings `halalas` to this checkout. */
  const [gift, setGift] = useState<{ code: string; halalas: number } | null>(null);
  const [giftError, setGiftError] = useState<string | null>(null);
  const [giftChecking, setGiftChecking] = useState(false);
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

  // As the server saw the URL: usePaymentReturn drops `?paid=` from the address
  // bar, and a second run of the effect below (React dev mode) reading it there
  // would see a plain visit and release the hold she is paying for.
  const returning = Boolean(searchParams.paid);

  useEffect(() => {
    // Back from StreamPay's checkout, the hold is the one she was paying for:
    // keep it, so paying again reuses it instead of fighting it for the chair.
    // Its email comes back with it — the box is empty after the redirect, and a
    // hold saved with a blank email can never be released early.
    if (returning) {
      const held = loadCheckout()?.held;
      setHeldCode(held?.code ?? null);
      if (held?.email) setEmail(held.email);
    } else {
      // Back here any other way — Back from the bank's page, a dropped
      // connection, a reload. A hold the server kept is one she is paying for
      // or has paid: show her that, never a Pay button that books her twice.
      // Checking from the first frame when there is a hold to ask about, so a
      // reload does not show the form for the seconds that takes.
      if (loadCheckout()?.held) setResuming(true);
      released.current = releaseHold().then((kept) => {
        if (kept) void resumeHeld(kept.held);
        else setResuming(false);
      });
    }
    const saved = loadBooking();
    if (saved) setBooking(saved);
    setLoaded(true);
  }, []);

  // Leaving checkout — closing the tab, going elsewhere — lets her chair go at
  // once instead of when the hold runs out. The server keeps a hold she is still
  // paying for (her bank's page is also a "leaving"), so this cannot cost her it.
  useEffect(() => {
    const onHide = () => {
      const held = loadCheckout()?.held;
      if (held) navigator.sendBeacon("/api/bookings/release", JSON.stringify(held));
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
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
    if (saved.wallet) {
      setGift(saved.wallet.gift);
      setGiftInput(saved.wallet.gift?.code ?? "");
    }
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
      })
      // Answered either way: the loader waits for it, so her details do not
      // pop into the form a moment after it appears.
      .finally(() => setAccountChecked(true));
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

  // Her balance when signed in. A checkout must still work without it.
  useEffect(() => {
    void fetch("/api/wallet/quote")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.signedIn) setWalletAvailable(d.available ?? 0);
      })
      .catch(() => {
        /* an extra; the checkout works without it */
      });
  }, []);

  // A gift card works only with the email it was sent to, so a guest who changes
  // the email takes it off rather than being refused at Pay.
  useEffect(() => {
    if (!signedIn) setGift(null);
  }, [email, signedIn]);

  // A direct visit with nothing selected has nothing to pay for.
  // The booking pages save as she goes, so what arrives can be half-picked. The
  // party's time is only filled in once every guest has one of her own.
  const hasSelection =
    booking.members.length > 0 && booking.startsAt !== null && booking.members.every((m) => m.serviceId);

  // The invoice is emailed the moment the charge clears, so an address is as
  // required as the phone number. Kept loose on purpose — the server's zod
  // schema is the real check, and a strict regex here only ever rejects
  // addresses that are actually valid.
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const phoneOk = isValidSaudiMobile(phone);

  /** The upsells this guest has taken. */
  const treatsFor = (i: number) => (booking.checkoutAddons ?? []).filter((a) => treats.includes(`${i}:${a.id}`));

  /**
   * What the treats add. Outside the discount stack entirely — a coffee is 10
   * SAR whether or not two people booked together, whether or not a code was
   * typed, whether or not points were spent. lib/bookings.ts holds them out of
   * `grossHalalas` for the same reason and adds them back last.
   *
   * So this leaves booking.total alone, and the promo and the reward below stay
   * quoted against a figure ticking a checkbox cannot move.
   */
  const treatsTotal = booking.members.reduce((sum, _m, i) => sum + treatsFor(i).reduce((s, a) => s + a.price, 0), 0);

  /**
   * What the customer actually pays: the quoted bill, less the code, less the
   * reward. In that order, matching lib/bookings.ts exactly — the reward is
   * quoted against the post-promo figure there, so quoting it against anything
   * else here would show a number the charge disagrees with. Then the treats,
   * which no discount touches.
   */
  const beforeCredit = booking.total - promoDiscountSar - redeemDiscountSar + treatsTotal;

  /**
   * Then her credit, last, as lib/bookings.ts takes it, and by the same rule
   * (walletSpendOk): never more than she has or the bill, and never leaving the
   * card under 1 SAR. Signed in, what she typed, from her balance plus a card
   * she added; a guest, all the card can pay (walletCovers). Sent with the
   * booking, which checks it again and refuses if it can't be spent.
   */
  const billHalalas = Math.round(beforeCredit * 100);
  const walletSpendable = (signedIn ? walletAvailable : 0) + (gift?.halalas ?? 0);
  const walletHalalas = signedIn
    ? walletSpendOk(walletPick.halalas, billHalalas, walletSpendable)
      ? walletPick.halalas
      : 0
    : walletCovers(billHalalas, walletSpendable);
  /** What she typed can't be spent: the field says why, and Pay waits. */
  const walletTypedBad = signedIn && !walletPick.ok && walletSpendable > 0 && billHalalas > 0;
  const walletSar = walletHalalas / 100;
  const payableTotal = Math.round((beforeCredit - walletSar) * 100) / 100;

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
  const readyToConfirm = phoneOk && emailOk && checkout === null && !walletTypedBad;

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

  /**
   * What a typed gift card brings — display only. The booking claims it, and
   * only with the email it was sent to: a guest's typed email, or her account's.
   */
  const applyGift = async () => {
    const code = giftInput.trim();
    if (!code || giftChecking) return;
    setGiftChecking(true);
    setGiftError(null);
    try {
      const res = await fetch("/api/wallet/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, email: email.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 429) {
        setGiftError(p.giftErrors.tooMany);
        return;
      }
      if (!data.ok) {
        setGift(null);
        setGiftError(data.error === "gift-card-claimed" ? p.giftErrors.claimed : p.giftErrors.invalid);
        return;
      }
      setGift({ code, halalas: data.halalas });
    } catch {
      setGiftError(p.giftErrors.invalid);
    } finally {
      setGiftChecking(false);
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
      wallet: { gift },
      held: heldCode ? { code: heldCode, email: email.trim() } : null,
    });
    // `email` is read only alongside a new hold; typing does not need a write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, treats, promoApplied, redeemPoints, gift, heldCode]);

  const confirm = async () => {
    if (!hasSelection || submitting) return;
    // Guarded here as well as on the disabled prop: Enter in a field can still
    // reach this.
    if (!emailOk) {
      setError(p.invalidEmail);
      return;
    }
    setError(null);
    setPayNotice(null);
    setResumed(false);
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
            // What the screen shows her credit paying, and the card she typed.
            // Whose wallet is the session's; the server refuses if it differs.
            walletHalalas: walletHalalas || null,
            giftCardCode: gift?.code ?? null,
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
          } else if (data.error === "refill-window") setError(p.refillWindow);
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
          // Her credit moved since the screen showed it (another tab spent it):
          // the hold was refused rather than charged more. Show what is there.
          else if (data.error === "wallet-changed") {
            if (signedIn && typeof data.walletBalance === "number") setWalletAvailable(data.walletBalance);
            else setGift(null);
            setError(p.walletChanged);
          } else if (data.error === "gift-card-invalid" || data.error === "gift-card-claimed") {
            setGift(null);
            setGiftError(data.error === "gift-card-claimed" ? p.giftErrors.claimed : p.giftErrors.invalid);
            setError(p.giftRejected);
          }
          // Name her. The party is refused as a whole — that part is right —
          // but with four guests at four hours, "that time has gone" does not
          // say which one to change. Falls back to the unnamed line for a solo
          // booking, where there is only one time it could be.
          else if (res.status === 429) setError(p.tooMany);
          else if (res.status === 409) {
            const at = data.guestIndex;
            const who =
              typeof at === "number" && booking.members.length > 1
                ? booking.members[at]?.guestName || c.booking.guestN.replace("{n}", String(at + 1))
                : null;
            setError(who ? p.slotTakenGuest.replace("{name}", who) : p.slotTaken);
          } else if (data.error === "invalid" && data.issues?.includes("customer.phone")) {
            setError(p.invalidPhone);
          } else if (data.error === "invalid" && data.issues?.includes("customer.email")) {
            setError(p.invalidEmail);
          } else setError(p.bookingFailed);
          return;
        }

        code = (await res.json()).bookings[0].code as string;
        setHeldCode(code);
      }

      await payHeld(code);
    } catch {
      setError(p.bookingFailed);
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Step 2 — the checkout. Only a verified payment confirms anything. A hold
   * already paid comes back as its tickets; one being paid, as the same checkout.
   */
  const payHeld = async (code: string) => {
    const pay = await fetch("/api/payments/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });

    const data = await pay.json().catch(() => ({}));
    if (pay.ok && data.checkout) {
      setCheckout(data.checkout);
      return true;
    }
    if (pay.ok) {
      clearBooking();
      showPaidOn("/booking", "booking", data.tickets);
      return "paid" as const;
    }
    showPayError(data.error);
    return false;
  };

  /** Her kept hold (releaseHold): paid shows the tickets, paying reopens it. */
  const resumeHeld = async (held: { code: string; email: string }) => {
    setHeldCode(held.code);
    setEmail(held.email);
    setResuming(true);
    setResumed(true);
    try {
      await payHeld(held.code);
    } catch {
      setError(p.bookingFailed);
    } finally {
      setResuming(false);
    }
  };

  const showPayError = (code: string | undefined) => {
    const kind = noticeOf(code);
    // The hold is gone — lapsed, or charged after it lapsed and refunded — so a
    // retry on it would confirm nothing: the next Continue makes a new one.
    if (kind === "expired" || kind === "refunded") setHeldCode(null);
    const messages: Record<PayNotice, string> = {
      declined: p.declined,
      expired: p.expired,
      refunded: p.refunded,
      checking: p.unconfirmed,
      "too-many": p.tooMany,
      failed: p.bookingFailed,
    };
    notifyPay(messages[kind], kind);
  };

  /** The embedded checkout ended — or she came back from the hosted one. */
  const onPaid = (outcome: PaymentOutcome) => {
    // Declined, and that checkout is over: straight into a new one on the hold
    // she still has, rather than back to step 1 to press Pay again. Not after
    // the timer ran out — a new checkout for someone who walked away would keep
    // her chair from everyone for another ten minutes. The server still decides:
    // a hold that has lapsed comes back `expired` and she lands on step 1.
    const reopen =
      outcome.status === "failed" &&
      !outcome.checkout &&
      outcome.error === "payment-declined" &&
      outcome.reason !== "timedOut" &&
      heldCode !== null;
    // A decline with the checkout still open re-opens it right here. One being
    // replaced stays on screen, under the loader, until the new one arrives:
    // clearing it drew step 1 for a moment on the way.
    if (!reopen) setCheckout(outcome.status === "failed" ? (outcome.checkout ?? null) : null);
    if (outcome.status === "paid" && outcome.result.kind === "booking") {
      clearBooking();
      showPaidOn("/booking", "booking", outcome.result.tickets);
      return;
    }
    const why = declineMessage(c.payDecline, outcome);
    if (why) notifyPay(why);
    else showPayError(outcome.status === "failed" ? outcome.error : undefined);

    if (reopen) {
      setReopening(true);
      void payHeld(heldCode)
        .then((result) => {
          // Paid after all (an earlier attempt came through): the loader stays
          // up while the page leaves for the success popup.
          if (result === "paid") return;
          // Refused (the hold lapsed, say): the dead checkout goes, and step 1
          // says why — payHeld has already put the reason up.
          if (!result) setCheckout(null);
          setReopening(false);
        })
        .catch(() => {
          setCheckout(null);
          setError(p.bookingFailed);
          setReopening(false);
        });
    }
  };
  const checkingPayment = usePaymentReturn(onPaid, returning);

  /** Her removal, design and own time, as one line under her service. */
  const details = (m: (typeof booking.members)[number]) =>
    [m.removal, m.design, m.timeLabel ? `${m.branch ? `${m.branch} · ` : ""}${m.timeLabel}` : null]
      .filter(Boolean)
      .join(" · ");

  /** A card the server priced, with the way to take it off. */
  const giftChip = gift && (
    <div className="flex items-center justify-between rounded-[12px] border border-red/20 bg-red/[0.04] px-4 py-3">
      <span className="text-sm font-semibold text-red">{p.giftApplied.replace("{sar}", formatSAR(gift.halalas))}</span>
      <button
        type="button"
        onClick={() => {
          setGift(null);
          setGiftInput("");
        }}
        className="text-[12px] font-semibold text-ink/50 underline underline-offset-4 hover:text-ink"
      >
        {p.giftRemove}
      </button>
    </div>
  );
  const giftField = (
    <div className="flex gap-2">
      <input
        value={giftInput}
        onChange={(e) => setGiftInput(e.target.value.toUpperCase())}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void applyGift();
          }
        }}
        dir="ltr"
        maxLength={40}
        placeholder="XXXX-XXXX-XXXX-XXXX"
        autoCapitalize="characters"
        className="min-w-0 flex-1 rounded-[12px] border border-black/[0.08] px-4 py-3 text-left text-sm uppercase tracking-wider text-ink outline-none placeholder:text-ink/30 focus:border-red/40"
      />
      <button
        type="button"
        onClick={() => void applyGift()}
        disabled={!giftInput.trim() || giftChecking}
        className="shrink-0 rounded-[12px] bg-black/[0.06] px-5 text-sm font-bold text-ink transition-colors hover:bg-black/[0.1] disabled:cursor-not-allowed disabled:text-ink/40"
      >
        {giftChecking ? p.promoApplying : p.giftApply}
      </button>
    </div>
  );

  // Step 2 replaces the page rather than appearing somewhere down it.
  const paying = checkout !== null;
  useEffect(() => {
    if (paying) window.scrollTo({ top: 0, behavior: "smooth" });
  }, [paying]);

  return (
    <main className="relative min-h-screen bg-cream">
      <SiteHeader />

      {/* One layout, whatever the bill says.

          The grid used to collapse to a single column the moment a credit
          covered everything, and spring back to two the moment a 10 SAR coffee
          was ticked. Adding a treat is a small decision and it was rearranging
          the whole screen — which reads as something going wrong, not as ten
          riyals being added. The columns stay; what changes is a number. */}
      {/* Step 1 carries it in its left column, so the bill beside it starts
          at the top of the screen and its button stays in view. */}
      {paying && (
        <div className="mx-auto flex max-w-page justify-center px-6 pt-[112px] md:px-12 lg:justify-start lg:px-16">
          <Steps current={2} labels={[p.stepDetails, p.stepPay]} />
        </div>
      )}

      {/* Step 2: only what paying needs. The form, extras and points are
          settled once the chair is held, so they leave the screen instead of
          sitting beside a checkout they no longer affect. */}
      {paying && checkout ? (
        <div className="mx-auto grid max-w-page gap-6 px-4 pb-24 pt-6 sm:px-6 md:px-12 lg:grid-cols-[1fr_400px] lg:gap-8 lg:px-16">
          <PayStep
            checkout={checkout}
            onDone={onPaid}
            notice={payNotice}
            info={resumed ? p.resumedPayment : null}
            sub={p.paySub}
          />

          {/* Her booking, beside the card form on a desktop and above it on a
              phone — what she is paying for never scrolls out of reach. */}
          <aside className="order-first h-fit rounded-[24px] bg-white p-5 text-start shadow-[0_20px_50px_rgba(184,0,7,0.06)] sm:p-6 lg:sticky lg:top-28 lg:order-none">
            <h2 className="font-display text-lg font-extrabold text-ink">{p.summaryTitle}</h2>
            <p className="mt-1 text-[13px] text-ink/55">
              {[booking.dateLabel, booking.timeLabel].filter(Boolean).join(" · ")}
            </p>

            <ul className="mt-4 divide-y divide-black/[0.06]">
              {booking.members.map((m, i) => (
                <li key={i} className="flex items-center gap-3 py-3 first:pt-0">
                  <ServiceThumb img={m.serviceImg} className="h-14 w-14" />
                  <div className="min-w-0 flex-1">
                    {booking.members.length > 1 && (
                      <p className="text-[11px] font-bold uppercase tracking-wider text-red/70">
                        {m.guestName || c.booking.guestN.replace("{n}", String(i + 1))}
                      </p>
                    )}
                    <p className="text-sm font-semibold text-ink">{m.service ?? "—"}</p>
                    {(m.addons.length > 0 || m.removal || m.timeLabel) && (
                      <p className="mt-0.5 text-[12px] text-ink/50">
                        {[...m.addons, m.removal, m.timeLabel].filter(Boolean).join(" · ")}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            <div className="mt-2 flex items-center justify-between rounded-[16px] bg-[#fbeaea] px-4 py-3.5">
              <p className="text-[13px] font-semibold text-ink/60">{creditTotal > 0 ? p.toPayNow : p.total}</p>
              <div className="flex items-center gap-1 font-display text-2xl font-extrabold text-red">
                <Riyal className="h-5 w-5" />
                {payableTotal}
              </div>
            </div>
            <p className="mt-3 text-center text-[11px] text-ink/45">{p.payFirstNote}</p>
          </aside>
        </div>
      ) : (
        <div className="mx-auto max-w-page px-4 pb-24 pt-[112px] sm:px-6 md:px-12 lg:px-16">
          {loaded && !hasSelection ? (
            <div className="rounded-[24px] bg-white p-8 text-center shadow-[0_20px_50px_rgba(184,0,7,0.06)]">
              <p className="text-sm text-ink/70">{p.noSelection}</p>
              <Link
                href="/booking"
                className="mt-3 inline-block rounded-[12px] bg-red-grad px-5 py-2.5 text-sm font-bold text-white"
              >
                {p.newBooking}
              </Link>
            </div>
          ) : (
            // Two columns: what she is booking on the left, and on the right,
            // sticky, everything that turns it into a bill and pays it. Every
            // list wraps or scrolls on its own, so a group of four with add-ons
            // and treats grows the page, never breaks it.
            <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
              <div className="space-y-4">
                <div className="flex justify-center lg:justify-start">
                  <Steps current={1} labels={[p.stepDetails, p.stepPay]} />
                </div>
                {/* What she is booking: each service with its picture and her
                add-ons', then when and for whom, then the treats. */}
                <section className="rounded-[24px] bg-white p-5 text-start shadow-[0_20px_50px_rgba(184,0,7,0.06)] sm:p-6">
                  <h1 className="font-display text-2xl font-extrabold text-ink">{p.summaryTitle}</h1>

                  <div className="mt-5 space-y-3">
                    <ul className="space-y-3">
                      {booking.members.map((m, i) => (
                        <li key={i} className="flex items-start gap-4 rounded-[16px] border border-black/[0.05] p-3">
                          <ServiceThumb img={m.serviceImg} className="h-20 w-20" />
                          <div className="min-w-0 flex-1">
                            {booking.members.length > 1 && (
                              <p className="text-[11px] font-bold uppercase tracking-wider text-red/70">
                                {m.guestName || c.booking.guestN.replace("{n}", String(i + 1))}
                              </p>
                            )}
                            <p className="truncate font-display text-base font-extrabold text-ink">
                              {m.service ?? "—"}
                            </p>
                            {details(m) && <p className="mt-0.5 text-[12px] text-ink/50">{details(m)}</p>}
                            {/* Her add-ons, each with its picture; they wrap. */}
                            {m.addons.length > 0 && (
                              <ul className="mt-2 flex flex-wrap gap-1.5">
                                {m.addons.map((name, k) => (
                                  <li
                                    key={k}
                                    className="flex items-center gap-1.5 rounded-full bg-cream/80 py-1 pe-3 ps-1 text-[12px] font-semibold text-ink/70"
                                  >
                                    <ServiceThumb img={m.addonImgs?.[k]} className="h-6 w-6" small />
                                    {name}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                          <span className="flex shrink-0 items-center gap-1 font-display text-lg font-extrabold text-ink">
                            <Riyal className="h-4 w-4" />
                            {m.price}
                          </span>
                        </li>
                      ))}
                    </ul>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-[16px] bg-cream/70 p-4">
                        <p className="text-[11px] text-ink/45">{c.booking.appointment}</p>
                        <p className="mt-0.5 text-sm font-semibold text-ink">
                          {booking.dateLabel && booking.timeLabel
                            ? `${booking.dateLabel} · ${booking.timeLabel}`
                            : c.booking.notSelected}
                        </p>
                        {booking.branch && <p className="mt-0.5 text-[12px] text-ink/50">{booking.branch}</p>}
                      </div>
                      {/* Signed in, her account already answered who this is for.
                      She changes it on /account, where the change sticks. */}
                      {signedIn && (
                        <div className="rounded-[16px] bg-cream/70 p-4">
                          <p className="text-[11px] text-ink/45">{p.bookingFor}</p>
                          <p className="mt-0.5 truncate text-sm font-semibold text-ink">{name || email}</p>
                          <p dir="ltr" className="mt-0.5 truncate text-start text-[12px] text-ink/50">
                            {email}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Required: the email carries the booking reference that is the
                  only key to /my-bookings, and the invoice goes there. */}
                  {!signedIn && (
                    <div className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-3 border-t border-black/[0.05] pt-5">
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

                  {/* Coffee and a cookie, one tile per guest, so one can take it and
                another skip it. Frozen once the chairs are held: the retry after
                a declined card re-uses that hold and never re-prices it, so a
                treat added now would be shown and not charged. */}
                  {(booking.checkoutAddons?.length ?? 0) > 0 && (
                    <div className="mt-6 border-t border-black/[0.05] pt-5">
                      <h2 className="font-display text-base font-extrabold text-ink">{p.treatLabel}</h2>
                      <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-2">
                        {booking.members.map((_, i) =>
                          (booking.checkoutAddons ?? []).map((a) => {
                            const key = `${i}:${a.id}`;
                            const taken = treats.includes(key);
                            return (
                              <label
                                key={key}
                                className={`flex items-center gap-3 rounded-[14px] border p-2.5 pe-4 text-[13px] ${
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
                                      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
                                    )
                                  }
                                  className="ms-1.5 h-4 w-4 shrink-0 accent-red"
                                />
                                {/* The salon's photo, or a drawn cup on beige: never an
                              empty box that reads as a broken image. */}
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
                </section>
              </div>

              {/* The bill, built in the order it comes off: the code, her
                  points, her wallet or a guest's gift card, then what is left,
                  how it is paid, and the button. Sticky beside the booking while
                  it fits; taller, it scrolls with the page like the rest. */}
              <aside className="space-y-3 rounded-[24px] bg-white p-5 text-start shadow-[0_20px_50px_rgba(184,0,7,0.06)] lg:sticky lg:top-28">
                <h2 className="font-display text-lg font-extrabold text-ink">{p.payWith}</h2>

                {/* Occasion codes (brief §2.10). Not offered against a bill a
                    membership already cleared: a percentage of zero is zero. */}
                {!fullyCovered && (
                  <div>
                    {promoApplied ? (
                      <div className="flex items-center justify-between rounded-[12px] border border-red/20 bg-red/[0.04] px-4 py-2.5">
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
                          placeholder={`${p.promoLabel} · ${p.promoPlaceholder}`}
                          aria-label={p.promoLabel}
                          className="min-w-0 flex-1 rounded-[12px] border border-black/[0.08] px-4 py-2.5 text-start text-sm uppercase text-ink outline-none placeholder:normal-case placeholder:text-ink/30 focus:border-red/40"
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

                {/* Her points, as one step of paying: what she can take off
                    now, and what this booking earns for the next one. A guest
                    sees the earning, and the way to sign in and use it. The
                    rungs are only those she can afford, bounded by the bill:
                    150 points against a 20 SAR bill burns 30 SAR for 20 off. */}
                {rules !== null &&
                  (() => {
                    const affordable =
                      balance !== null && !fullyCovered
                        ? redeemable(balance, Math.round((booking.total - promoDiscountSar) * 100), rules)
                        : [];
                    if (affordable.length === 0 && !redeemError) return null;
                    return (
                      <div>
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="text-[12px] text-ink/55">{a.walletTitle}</span>
                          {balance !== null && (
                            <span className="text-[12px] font-semibold text-red">
                              {a.redeemBalance.replace("{n}", String(balance))}
                            </span>
                          )}
                        </div>
                        {affordable.length > 0 && (
                          <div className="relative">
                            <select
                              value={redeemPoints ?? ""}
                              onChange={(e) => void pickReward(e.target.value === "" ? null : Number(e.target.value))}
                              aria-label={a.redeemLabel}
                              className={`w-full cursor-pointer appearance-none rounded-[12px] border px-4 py-2.5 pe-10 text-sm font-semibold outline-none focus:border-red/40 ${
                                redeemPoints !== null
                                  ? "border-red/30 bg-red/[0.04] text-red"
                                  : "border-black/[0.08] text-ink"
                              }`}
                            >
                              <option value="">{a.redeemNone}</option>
                              {affordable.map((points) => (
                                <option key={points} value={points}>
                                  {`${a.rewardOff.replace("{sar}", String((points * rules.pointHalalas) / 100))} · ${a.rewardPoints.replace("{points}", String(points))}`}
                                </option>
                              ))}
                            </select>
                            <span
                              aria-hidden
                              className="pointer-events-none absolute inset-y-0 end-4 flex items-center text-ink/40"
                            >
                              ▾
                            </span>
                          </div>
                        )}
                        {redeemError && (
                          <p role="alert" className="mt-1.5 text-[11px] text-red">
                            {redeemError}
                          </p>
                        )}
                      </div>
                    );
                  })()}

                {/* Her wallet, or a guest's gift card. Signed in, her gift cards
                    are already in her wallet, so she types how much of it to
                    spend, and the card field waits behind a link for a card sent
                    with no email. A guest has no wallet to show: she types the
                    card, sent to the email above, and it pays all it can. */}
                {hasSelection && billHalalas > 0 && (
                  <div>
                    {signedIn ? (
                      <div className="space-y-2">
                        {walletSpendable > 0 && (
                          <WalletAmount
                            available={walletSpendable}
                            billHalalas={billHalalas}
                            onChange={(halalas, ok) => setWalletPick({ halalas, ok })}
                          />
                        )}
                        {gift ? (
                          giftChip
                        ) : giftOpen ? (
                          giftField
                        ) : (
                          <button
                            type="button"
                            onClick={() => setGiftOpen(true)}
                            className="px-1 text-[12px] font-semibold text-red underline underline-offset-4 hover:opacity-70"
                          >
                            {p.giftHave}
                          </button>
                        )}
                      </div>
                    ) : (
                      <>
                        <span className="mb-1.5 block text-[12px] text-ink/55">{p.giftLabel}</span>
                        {gift ? giftChip : giftField}
                        {!gift && <span className="mt-1.5 block text-[11px] text-ink/40">{p.giftGuestNote}</span>}
                      </>
                    )}
                    {giftError && (
                      <p role="alert" className="mt-1.5 text-[11px] text-red">
                        {giftError}
                      </p>
                    )}
                  </div>
                )}

                <div className="border-t border-black/[0.06]" />

                {/* What the membership is covering, said before any card is
                    asked for: she is not paying for it out of her own pocket. */}
                {covered.length > 0 && (
                  <div className="rounded-[16px] bg-[#f2f7f2] p-4 ring-1 ring-[#2f6b3f]/15">
                    <p className="text-[13px] font-extrabold text-[#2f6b3f]">{p.coveredTitle}</p>
                    <ul className="mt-2 space-y-1.5">
                      {covered.map((m, i) => (
                        <li key={i} className="flex items-center justify-between gap-3 text-[13px]">
                          <span className="truncate text-ink/70">
                            {p.coveredService.replace("{service}", m.service ?? "").replace("{pack}", m.packName ?? "")}
                          </span>
                          <span className="flex shrink-0 items-center gap-1 font-semibold text-[#2f6b3f]">
                            −<Riyal className="h-3 w-3" />
                            {m.creditSar}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-[12px] text-ink/50">{p.coveredNote}</p>
                  </div>
                )}

                {(booking.total < booking.grossTotal ||
                  promoDiscountSar > 0 ||
                  redeemDiscountSar > 0 ||
                  walletSar > 0 ||
                  treatsTotal > 0) && (
                  <div className="space-y-1 rounded-[14px] bg-cream/60 px-4 py-3 text-[13px]">
                    <BillLine label={p.subtotal} sar={booking.grossTotal + creditTotal} muted />
                    {creditTotal > 0 && <BillLine label={p.membershipLine} sar={-creditTotal} green />}
                    {booking.total < booking.grossTotal && (
                      <BillLine label={p.groupDiscount} sar={-(booking.grossTotal - booking.total)} />
                    )}
                    {promoDiscountSar > 0 && <BillLine label={promoApplied ?? ""} sar={-promoDiscountSar} ltr />}
                    {redeemDiscountSar > 0 && (
                      <BillLine
                        label={a.redeemApplied
                          .replace("{sar}", String(redeemValueSar))
                          .replace("{points}", String(redeemPoints ?? 0))}
                        sar={-redeemDiscountSar}
                      />
                    )}
                    {treatsTotal > 0 && <BillLine label={p.treatLabel} sar={treatsTotal} muted />}
                    {walletSar > 0 && <BillLine label={signedIn ? p.walletLine : p.giftLine} sar={-walletSar} />}
                  </div>
                )}

                <div className="rounded-[16px] bg-[#fbeaea] px-4 py-3">
                  <div className="flex items-center justify-between">
                    <p className="text-[13px] font-semibold text-ink/60">{creditTotal > 0 ? p.toPayNow : p.total}</p>
                    <div className="flex items-center gap-1 font-display text-2xl font-extrabold text-red">
                      <Riyal className="h-5 w-5" />
                      {formatSAR(Math.round(payableTotal * 100))}
                    </div>
                  </div>
                  {/* What this bill earns, said as money. A guest earns it on her
                      email's account and is shown the way to sign in for it;
                      the selection is saved, so nothing she picked is lost. */}
                  {rules !== null &&
                    payableTotal > 0 &&
                    (() => {
                      const earned = pointsEarned(Math.round(payableTotal * 100), rules);
                      if (earned === 0) return null;
                      return (
                        <p className="mt-1 text-[12px] text-ink/60">
                          {a.earnGives
                            .replace("{value}", String((earned * rules.pointHalalas) / 100))
                            .replace("{points}", String(earned))}
                          {!signedIn && (
                            <>
                              {" "}
                              <Link
                                href={`/account?next=${encodeURIComponent("/booking/payment")}`}
                                className="font-semibold text-red underline underline-offset-2"
                              >
                                {a.earnSignIn}
                              </Link>
                            </>
                          )}
                        </p>
                      );
                    })()}
                </div>

                {/* The card, for whatever is left. Asking for a card to charge
                    nothing is a step she notices before the code does. */}
                {nothingToPay ? (
                  <p className="rounded-[14px] bg-cream/70 p-4 text-sm font-semibold text-ink/70">{p.nothingLeft}</p>
                ) : (
                  covered.length > 0 && <p className="text-[12px] text-ink/50">{p.remainderNote}</p>
                )}

                {(error ?? payNotice) && (
                  <p role="alert" className="rounded-[12px] bg-red/[0.08] px-4 py-3 text-start text-xs text-red">
                    {error ?? payNotice}
                  </p>
                )}

                <button
                  type="button"
                  onClick={confirm}
                  disabled={submitting || !readyToConfirm}
                  className={`block w-full rounded-[12px] py-3 text-center text-sm font-bold transition-opacity ${
                    submitting || !readyToConfirm
                      ? "cursor-not-allowed bg-black/[0.06] text-ink/40"
                      : "bg-red-grad text-white hover:opacity-90"
                  }`}
                >
                  {submitting ? p.confirming : nothingToPay ? p.confirmBooking : p.continueToPay}
                </button>
                {nothingToPay ? (
                  creditTotal > 0 ? null : (
                    <p className="text-center text-[12px] text-ink/55">{p.nothingToPay}</p>
                  )
                ) : (
                  <>
                    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
                      <PayLogos small />
                      <span className="flex items-center gap-1 text-[11px] text-ink/45">
                        <Lock className="h-3 w-3" />
                        {p.secure}
                      </span>
                    </div>
                    <p className="text-center text-[11px] text-ink/40">{p.payFirstNote}</p>
                  </>
                )}
              </aside>
            </div>
          )}
        </div>
      )}

      <SiteFooter />

      {/* From the first paint on a reload (loaded starts false on the server
          too) until the page is as it will stay: her selection back, her
          details in, and any payment she had going found. */}
      {checkingPayment || resuming ? (
        <CheckingModal />
      ) : (
        (!loaded || !accountChecked || reopening) && <CheckingModal loading />
      )}
      {noticeOpen && payNotice && !checkingPayment && !reopening && (
        <PayNoticeModal
          message={payNotice}
          notice={noticeKind}
          retry={paying}
          onClose={() => setNoticeOpen(false)}
        />
      )}
    </main>
  );
}

/** A service's catalogue picture, or a drawn sparkle on beige when it has none. */
function ServiceThumb({ img, className, small }: { img?: string | null; className: string; small?: boolean }) {
  return (
    <span
      className={`grid shrink-0 place-items-center ${small ? "rounded-full" : "rounded-[14px]"} bg-[#e7d9c9] bg-cover bg-center bg-no-repeat text-[#8a6a4a] ${className}`}
      style={img ? { backgroundImage: `url(${img})` } : undefined}
    >
      {!img && <Sparkles className={small ? "h-3 w-3" : "h-6 w-6"} strokeWidth={1.75} aria-hidden />}
    </span>
  );
}

/** One line of the bill: a label and an amount in SAR, negative for what comes off. */
function BillLine({
  label,
  sar,
  muted,
  green,
  ltr,
}: {
  label: string;
  sar: number;
  muted?: boolean;
  green?: boolean;
  ltr?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 ${
        muted ? "text-ink/55" : green ? "font-semibold text-[#2f6b3f]" : "font-semibold text-red"
      }`}
    >
      <span dir={ltr ? "ltr" : undefined} className="min-w-0 truncate">
        {label}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {sar < 0 && "−"}
        <Riyal className="h-3 w-3" />
        {formatSAR(Math.round(Math.abs(sar) * 100))}
      </span>
    </div>
  );
}
