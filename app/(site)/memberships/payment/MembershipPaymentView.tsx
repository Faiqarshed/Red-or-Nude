"use client";

// The membership checkout: what she is buying, how she is paying, and what to do
// with it afterwards.
//
// Same shape as the booking payment screen next door — summary on one side,
// methods on the other — so the two purchases on this site feel like one salon.
// Once Pay is pressed, the same two-step frame as every checkout (PayStep): the
// timer, the loader while the form draws and while a payment is confirmed, and
// the reason a payment failed, in front.
//
// Signing in is a wall here, unlike everywhere else, and that is the feature:
// credits live on a customer account, so there is nowhere to put them for a
// guest. Said before the card form rather than after it.

import { useState } from "react";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import PaymentMethods from "@/components/PaymentMethods";
import { declineMessage, usePaymentReturn, type PaymentOutcome } from "@/components/StreamPayCheckout";
import { CheckingModal, PayNoticeModal, PayStep } from "@/components/PayFlow";
import { Riyal, Lock } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { pick } from "@/lib/localized";
import { showPaidOn } from "@/lib/paid-handoff";
import type { PublicPack } from "@/lib/catalog";
import PackLines from "../PackLines";
import { useWalletCredit } from "@/components/WalletCredit";
import { formatSAR } from "@/lib/money";
import { noticeOf, type PayNotice } from "@/lib/payments/notice";

export default function MembershipPaymentView({
  pack,
  signedIn,
  returning,
}: {
  pack: PublicPack;
  signedIn: boolean;
  /** Back from the bank (`?paid=`): the loader is drawn from the first paint. */
  returning: boolean;
}) {
  const { c, lang } = useI18n();
  const p = c.payment;
  const k = c.packs;

  const [submitting, setSubmitting] = useState(false);
  /** Her wallet credit, if she switches it on: what it pays, and the rest for the card. */
  const priceHalalas = Math.round(pack.priceSar * 100);
  const credit = useWalletCredit(priceHalalas);
  const toPayHalalas = priceHalalas - credit.halalas;
  const [error, setError] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<{ ref: string; url: string } | null>(null);
  // A payment that did not end in paid, said in front (PayNoticeModal) and kept
  // above the checkout, as on the other checkouts.
  const [payNotice, setPayNotice] = useState<string | null>(null);
  const [noticeKind, setNoticeKind] = useState<PayNotice>("declined");
  const [noticeOpen, setNoticeOpen] = useState(false);
  /**
   * The charge went through and the credits did not, so it is being refunded.
   * The button stays off: pressing it again can only charge her a second time
   * while the first is still on its way back.
   */
  const [paidNotGranted, setPaidNotGranted] = useState(false);
  // Paid: back to the shelf, which shows what she bought over itself. The
  // expiry there counts from now.
  const bought = () => showPaidOn("/memberships", "pack", { pack, boughtAt: Date.now() });

  /** What to tell her, by what it means for her money (lib/payments/notice.ts). */
  const messages: Record<PayNotice, string> = {
    declined: k.declined,
    refunded: k.paidNotGranted,
    checking: k.unconfirmed,
    "too-many": p.tooMany,
    expired: k.failed,
    failed: k.failed,
  };

  const onPaid = (outcome: PaymentOutcome) => {
    setCheckout(outcome.status === "failed" ? (outcome.checkout ?? null) : null);
    if (outcome.status === "paid") return bought();
    const why = declineMessage(c.payDecline, outcome);
    const kind = why ? "declined" : noticeOf(outcome.error);
    if (kind === "refunded") setPaidNotGranted(true);
    setPayNotice(why ?? messages[kind]);
    setNoticeKind(kind);
    setNoticeOpen(true);
  };
  const checkingPayment = usePaymentReturn(onPaid, returning);

  const confirm = async () => {
    if (submitting || paidNotGranted) return;
    setSubmitting(true);
    setError(null);
    setPayNotice(null);
    try {
      const res = await fetch("/api/packs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packId: pack.id, walletHalalas: credit.halalas || undefined }),
      });

      const data = await res.json().catch(() => ({}));
      if (res.ok && data.checkout) setCheckout(data.checkout);
      else if (res.ok) bought();
      // Her credit moved since this page showed it: nothing was charged.
      else if (data.error === "wallet-changed") {
        credit.refused(data.walletBalance);
        setError(p.walletChanged);
      } else if (data.error === "signed-out") setError(k.signInFirst);
      else {
        const kind = noticeOf(data.error);
        if (kind === "refunded") setPaidNotGranted(true);
        setError(messages[kind]);
      }
    } catch {
      // A dropped connection may have come before or after the charge, so she
      // is sent to check her account before retrying, not told to try again.
      setError(k.failed);
    } finally {
      setSubmitting(false);
    }
  };

  const saving = pack.listPriceSar - pack.priceSar;

  const packSummary = (
    <>
      <h2 className="font-display text-lg font-extrabold text-ink">{k.chosen}</h2>

      <div className="mt-4 flex gap-4">
        <div
          className="h-[96px] w-[96px] shrink-0 rounded-[14px] bg-[#e7d9c9] bg-cover bg-center bg-no-repeat"
          style={pack.img ? { backgroundImage: `url(${pack.img})` } : undefined}
        />
        <div className="min-w-0">
          <p className="font-display text-lg font-extrabold text-ink">{pick(pack.name, lang)}</p>
          {pack.description && <p className="mt-1 text-[13px] text-ink/55">{pick(pack.description, lang)}</p>}
          <p className="mt-2 text-[12px] text-ink/45">{k.validFor.replace("{n}", String(pack.validDays))}</p>
        </div>
      </div>

      {/* What is in it, spelled out. Credits are per service, so a line per
          service is not a detail — it is the product. */}
      <div className="mt-5 border-t border-black/[0.05] pt-3">
        <PackLines lines={pack.lines} />
      </div>

      <div className="mt-4 flex items-end justify-between gap-3 border-t border-black/[0.05] pt-4">
        <span className="text-sm text-ink/55">{p.total}</span>
        <span className="flex flex-col items-end">
          <span className="flex items-center gap-1 font-display text-2xl font-extrabold text-red">
            <Riyal className="h-5 w-5" />
            {pack.priceSar}
          </span>
          {saving > 0 && (
            <span className="flex items-center gap-1 text-[12px] font-semibold text-[#2f6b3f]">
              {k.save}
              <Riyal className="h-3 w-3" />
              {saving}
            </span>
          )}
        </span>
      </div>

      {/* The things customers get wrong, said where they are spending. The
          late-cancellation rule is the one nobody expects of a prepaid
          credit, so it is said before she pays rather than when it bites. */}
      <p className="mt-4 rounded-[12px] bg-cream/70 p-3 text-[12px] leading-relaxed text-ink/55">
        {k.limits}. {k.lateCancel}
      </p>
    </>
  );

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      {/* The checkout titles itself ("Pay securely"). */}
      {!checkout && (
        <div className="mx-auto max-w-page px-6 pt-[120px] md:px-12 lg:px-16">
          <h1 className="text-start font-display text-3xl font-extrabold text-ink">{p.title}</h1>
        </div>
      )}

      {checkout ? (
        <div className="mx-auto grid max-w-page gap-6 px-4 pb-24 pt-[112px] sm:px-6 md:px-12 lg:grid-cols-[1fr_380px] lg:gap-8 lg:px-16">
          <PayStep checkout={checkout} onDone={onPaid} notice={payNotice} sub={k.paySub} />
          {/* What she is paying for: above the checkout on a phone, beside it on
              a desktop, so it never scrolls out of reach. */}
          <aside className="order-first h-fit rounded-[24px] bg-white p-6 text-start shadow-[0_20px_50px_rgba(184,0,7,0.06)] lg:sticky lg:top-28 lg:order-none">
            {packSummary}
          </aside>
        </div>
      ) : (
        <div className="mx-auto grid max-w-page gap-8 px-6 pb-20 pt-8 md:px-12 lg:grid-cols-[1fr_380px] lg:px-16">
          {/* -- what she is buying ----------------------------------------- */}
          <section className="h-fit rounded-[24px] bg-white p-6 text-start shadow-[0_20px_50px_rgba(184,0,7,0.06)]">
            {packSummary}
          </section>

          {/* -- and how she is paying -------------------------------------- */}
          <aside className="h-fit rounded-[24px] bg-white p-6 text-start shadow-[0_20px_50px_rgba(184,0,7,0.06)]">
            {!signedIn ? (
              // The wall, said plainly and before anything is filled in.
              <div className="rounded-[14px] bg-[#fbeaea] p-5 text-center">
                <p className="text-sm text-ink/70">{k.signInFirst}</p>
                <Link
                  // Straight back to this membership once she is in. Without it
                  // she landed on her account and had to find the shelf again.
                  href={`/account?next=${encodeURIComponent(`/memberships/payment?pack=${pack.id}`)}`}
                  className="mt-3 inline-block rounded-[12px] bg-red-grad px-5 py-2.5 text-sm font-bold text-white"
                >
                  {k.signIn}
                </Link>
              </div>
            ) : (
              <>
                {credit.field && (
                  <div className="mb-4 space-y-2">
                    {credit.field}
                    {credit.halalas > 0 && (
                      <p className="flex items-center justify-between px-1 text-[13px] font-semibold text-ink">
                        <span>{p.toPayNow}</span>
                        <span className="flex items-center gap-1">
                          <Riyal className="h-3.5 w-3.5" />
                          {formatSAR(toPayHalalas)}
                        </span>
                      </p>
                    )}
                  </div>
                )}
                {/* Credit that covers it all leaves nothing for a card. */}
                {toPayHalalas > 0 ? (
                  <PaymentMethods checkout={null} onDone={onPaid} />
                ) : (
                  <p className="rounded-[14px] bg-cream/70 p-4 text-sm font-semibold text-ink/70">{p.nothingLeft}</p>
                )}

                {/* Why the last attempt ended, still here once its checkout has closed. */}
                {(error ?? payNotice) && (
                  <p role="alert" className="mt-3 rounded-[12px] bg-red/[0.08] px-4 py-3 text-xs text-red">
                    {error ?? payNotice}
                  </p>
                )}

                <button
                  type="button"
                  onClick={confirm}
                  disabled={submitting || paidNotGranted || !credit.ok}
                  className={`mt-5 block w-full rounded-[12px] py-3.5 text-center text-sm font-bold transition-opacity ${
                    submitting || paidNotGranted
                      ? "cursor-not-allowed bg-black/[0.06] text-ink/40"
                      : "bg-red-grad text-white hover:opacity-90"
                  }`}
                >
                  {submitting ? k.paying : p.confirmPay}
                </button>

                <p className="mt-3 flex items-center justify-center gap-1.5 text-[12px] text-ink/45">
                  <Lock className="h-3.5 w-3.5" />
                  {p.secure}
                </p>
              </>
            )}
          </aside>
        </div>
      )}

      <SiteFooter />
      {checkingPayment && <CheckingModal />}
      {noticeOpen && payNotice && !checkingPayment && (
        <PayNoticeModal
          message={payNotice}
          notice={noticeKind}
          retry={checkout !== null}
          onClose={() => setNoticeOpen(false)}
        />
      )}
    </main>
  );
}
