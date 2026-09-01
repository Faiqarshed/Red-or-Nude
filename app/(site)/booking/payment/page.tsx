"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import PaymentMethods from "@/components/PaymentMethods";
import PhoneField from "@/components/PhoneField";
import { Riyal, Lock } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { clearBooking, emptySelection, loadBooking, type BookingSelection } from "@/lib/booking";
import { isValidSaudiMobile, toStoredPhone } from "@/lib/phone";
import { REWARDS } from "@/lib/rewards";

// Figma: Desktop-2 payment step (276:1902 / 276:6624) + success modal (276:6765).
//
// Two calls, in order:
//   POST /api/bookings         → holds the chair(s), rows written as `pending`
//   POST /api/payments/confirm → charges, confirms, and issues the ticket numbers
//
// Nothing is a booking until the second one succeeds. A declined card leaves the
// hold in place so the customer can retry without losing their slot, which is why
// the created code is kept in state between attempts.
//
// The gateway itself is still a stand-in (lib/payments/fake.ts) — no money moves
// until PAYMENT_DRIVER points at Moyasar or Tap.

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

const METHOD_KEYS = ["cardTitle", "madaTitle", "stcTitle", "appleTitle"] as const;

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
  const [method, setMethod] = useState(p.cardTitle);
  /** Set once the hold exists, so a retry after a decline doesn't re-book. */
  const [heldCode, setHeldCode] = useState<string | null>(null);
  /** Card fields live inside PaymentMethods; this mirrors their validity up. */
  const [cardValid, setCardValid] = useState(false);
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
  const [redeemPoints, setRedeemPoints] = useState<number | null>(null);
  const [redeemDiscountSar, setRedeemDiscountSar] = useState(0);
  const [redeemError, setRedeemError] = useState<string | null>(null);

  useEffect(() => {
    const saved = loadBooking();
    if (saved) setBooking(saved);
    setLoaded(true);
  }, []);

  // The ladder and the balance. Signed out this comes back with `signedIn:
  // false` and the picker simply never renders — an account is optional, and a
  // guest checkout must not grow a sign-in wall (brief §2.8).
  useEffect(() => {
    void fetch("/api/loyalty/quote")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.signedIn) setBalance(d.balance);
      })
      .catch(() => {
        /* the wallet is an extra; a checkout must still work without it */
      });
  }, []);

  // A direct visit with nothing selected has nothing to pay for.
  const hasSelection = booking.members.length > 0 && booking.startsAt !== null;

  // The invoice is emailed the moment the charge clears, so an address is as
  // required as the phone number. Kept loose on purpose — the server's zod
  // schema is the real check, and a strict regex here only ever rejects
  // addresses that are actually valid.
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const phoneOk = isValidSaudiMobile(phone);
  const canSubmit = phoneOk && emailOk && cardValid;

  /** Which enum value the API wants for the label the customer clicked. */
  const methodCode = (): "card" | "mada" | "stc" | "apple" => {
    const i = METHOD_KEYS.findIndex((k) => p[k] === method);
    return (["card", "mada", "stc", "apple"] as const)[i === -1 ? 0 : i];
  };

  /**
   * What the customer actually pays: the quoted bill, less the code, less the
   * reward. In that order, matching lib/bookings.ts exactly — the reward is
   * quoted against the post-promo figure there, so quoting it against anything
   * else here would show a number the charge disagrees with.
   */
  const payableTotal = booking.total - promoDiscountSar - redeemDiscountSar;

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

  const applyPromo = async () => {
    const code = promoInput.trim();
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

  /** The percentage of the picked rung. Read off the ladder, never stored. */
  const redeemPercent = redeemPoints ? (REWARDS.find((r) => r.points === redeemPoints)?.percent ?? 0) : 0;

  const rewardReasonText = (reason: string): string => {
    const e = a.redeemErrors;
    if (reason === "locked") return e.locked;
    if (reason === "signed-out") return e.signedOut;
    return e.unknown;
  };

  // A code applied or removed moves the total the percentage applies to, so a
  // reward picked before it is now priced against the wrong number. Re-quoting
  // is one request and keeps the summary honest.
  useEffect(() => {
    if (redeemPoints !== null) void pickReward(redeemPoints);
    // Intentionally keyed on the base total only: re-running on redeemPoints
    // would loop, since pickReward sets it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promoDiscountSar, booking.total]);

  const confirm = async () => {
    if (!hasSelection || submitting) return;
    // PaymentMethods has its own confirm button, which doesn't know about these
    // fields — so the guard lives here rather than only on the disabled prop.
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
        const res = await fetch("/api/bookings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            branchId: booking.branchId,
            startsAt: booking.startsAt,
            members: booking.members.map((m) => ({
              serviceId: m.serviceId,
              addonIds: m.addonIds,
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
          if (data.error === "refill-expired") setError(p.refillExpired);
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
          else if (res.status === 409) setError(p.slotTaken);
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

      // Step 2 — take the money. Only this confirms anything.
      const pay = await fetch("/api/payments/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, method: methodCode() }),
      });

      if (pay.ok) {
        const data = await pay.json();
        setTickets(data.tickets);
        clearBooking();
        return;
      }

      const data = await pay.json().catch(() => ({}));
      if (data.error === "payment-declined") setError(p.declined);
      else if (data.error === "expired") {
        // The hold is gone; a retry would confirm nothing, so send them back.
        setHeldCode(null);
        setError(p.expired);
      } else setError(p.bookingFailed);
    } catch {
      setError(p.bookingFailed);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="relative min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto grid max-w-page gap-8 px-6 pb-24 pt-[120px] md:px-12 lg:grid-cols-[1fr_540px] lg:px-16">
        <PaymentMethods onMethodChange={setMethod} onValidityChange={setCardValid} />

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
                        {i === 0 ? c.booking.guest1 : c.booking.guest2}
                      </p>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <Field label={p.rowService} value={m.service ?? "—"} />
                      <Field
                        label={c.booking.addons}
                        value={m.addons.length ? m.addons.join("، ") : c.booking.none}
                      />
                      <Field label={c.booking.removal} value={m.removal ?? c.booking.none} />
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

              {/* A booking needs someone to belong to — the picker never asked. */}
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

              {/* Occasion discount codes (brief §2.10). Applied before the hold
                  exists, so a code typed after a declined card still counts —
                  the retry re-uses the hold and never re-prices it. */}
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
                      onClick={applyPromo}
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

              {/* The loyalty ladder (brief §2.8). Rendered only for a signed-in
                  customer — an account is optional and a guest checkout must
                  never grow a sign-in wall. Locked rungs are shown but not
                  selectable, so the customer can see what they are working
                  towards instead of an empty box. */}
              {balance !== null && (
                <div className="mt-4">
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="text-[12px] text-ink/55">{a.redeemLabel}</span>
                    <span className="text-[11px] font-semibold text-red">
                      {a.redeemBalance.replace("{n}", String(balance))}
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    {REWARDS.map((r) => {
                      const unlocked = balance >= r.points;
                      const picked = redeemPoints === r.points;
                      return (
                        <label
                          key={r.points}
                          className={`flex items-center justify-between gap-3 rounded-[12px] border px-4 py-3 text-[13px] ${
                            picked
                              ? "border-red/40 bg-red/[0.04] text-red"
                              : unlocked
                                ? "cursor-pointer border-black/[0.08] text-ink hover:border-red/30"
                                : "cursor-not-allowed border-black/[0.05] text-ink/35"
                          }`}
                        >
                          <span className="flex items-center gap-2.5">
                            <input
                              type="radio"
                              name="reward"
                              checked={picked}
                              disabled={!unlocked}
                              onChange={() => void pickReward(r.points)}
                              className="accent-red"
                            />
                            <span className="font-semibold">
                              {a.rewardRow
                                .replace("{points}", String(r.points))
                                .replace("{percent}", String(r.percent))}
                            </span>
                          </span>
                          {!unlocked && (
                            <span className="text-[11px]">
                              {a.ladderLocked.replace("{n}", String(r.points - balance))}
                            </span>
                          )}
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
                </div>
              )}

              {(booking.total < booking.grossTotal ||
                promoDiscountSar > 0 ||
                redeemDiscountSar > 0) && (
                <div className="mt-4 space-y-1.5 rounded-[14px] bg-cream/60 p-4 text-[13px]">
                  <div className="flex items-center justify-between text-ink/55">
                    <span className="flex items-center gap-1">
                      <Riyal className="h-3 w-3" />
                      {booking.grossTotal}
                    </span>
                    <span>{p.subtotal}</span>
                  </div>
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
                          .replace("{percent}", String(redeemPercent))
                          .replace("{points}", String(redeemPoints ?? 0))}
                      </span>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-4 flex items-center justify-between rounded-[14px] bg-[#fbeaea] p-4">
                <div className="flex items-center gap-1 font-display text-2xl font-extrabold text-red">
                  <Riyal className="h-5 w-5" />
                  {payableTotal}
                </div>
                <p className="text-xs text-ink/45">{p.total}</p>
              </div>

              {error && (
                <p role="alert" className="mt-3 rounded-[12px] bg-red/[0.08] px-4 py-3 text-start text-xs text-red">
                  {error}
                </p>
              )}

              <button
                type="button"
                onClick={confirm}
                disabled={submitting || !canSubmit}
                className={`mt-6 block w-full rounded-[12px] py-3.5 text-center text-sm font-bold transition-opacity ${
                  submitting || !canSubmit
                    ? "cursor-not-allowed bg-black/[0.06] text-ink/40"
                    : "bg-red-grad text-white hover:opacity-90"
                }`}
              >
                {submitting ? p.confirming : p.confirmPay}
              </button>
              <p className="mt-3 text-center text-[11px] text-ink/40">{p.payFirstNote}</p>
              <p className="mt-2 flex items-center justify-center gap-1.5 text-[12px] text-ink/45">
                <Lock className="h-3.5 w-3.5" />
                {p.secure}
              </p>
            </>
          )}
        </aside>
      </div>

      <SiteFooter />

      {tickets && (
        <SuccessModal
          tickets={tickets}
          booking={booking}
          method={method}
          onClose={() => router.push("/")}
        />
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
  method,
  onClose,
}: {
  tickets: Ticket[];
  booking: BookingSelection;
  method: string;
  onClose: () => void;
}) {
  const { c, lang } = useI18n();
  const p = c.payment;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/30 px-4 py-10 backdrop-blur-sm">
      <div className="w-full max-w-[460px] rounded-[24px] bg-white p-8 text-center shadow-[0_40px_100px_rgba(0,0,0,0.25)]">
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
              { label: p.rowMethod, value: method },
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
