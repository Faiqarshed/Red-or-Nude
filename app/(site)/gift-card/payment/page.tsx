"use client";

import { useEffect, useState } from "react";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import PaymentMethods from "@/components/PaymentMethods";
import { declineMessage, usePaymentReturn, type PaymentOutcome } from "@/components/StreamPayCheckout";
import { CheckingModal, PayNoticeModal, PayStep, Steps } from "@/components/PayFlow";
import { GiftCardArt } from "@/components/gift/GiftCardArt";
import { Riyal, Lock } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { showPaidOn } from "@/lib/paid-handoff";
import { clearGiftSelection, loadGiftSelection, saveGiftSelection, type GiftSelection } from "@/lib/giftcard-selection";
import { useWalletCredit } from "@/components/WalletCredit";
import { formatSAR } from "@/lib/money";

// Figma: Desktop-2 gift-card payment step (325:7705) + success modal (325:8088).
//
// Pay opens StreamPay's checkout via POST /api/gift-cards; the card is issued
// once that payment is verified, and its redeemable code comes back through
// /api/payments/status (components/StreamPayCheckout.tsx). With the fake driver
// the code comes straight back from the POST.
//
// Delivery is the buyer's: the success modal shares the card on WhatsApp, to
// whoever she picks, or copies its link. Nothing is sent to a phone for her.
// A recipient email, if given, does get the card by email.

export default function GiftCardPaymentPage({ searchParams }: { searchParams: { paid?: string } }) {
  const { c, lang } = useI18n();
  const gp = c.giftPay;
  const p = c.payment;
  const [selection, setSelection] = useState<GiftSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [checkout, setCheckout] = useState<{ ref: string; url: string } | null>(null);
  // A failed payment, said in front (PayNoticeModal) and kept above the checkout.
  const [payNotice, setPayNotice] = useState<string | null>(null);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const notifyPay = (message: string) => {
    setPayNotice(message);
    setNoticeOpen(true);
  };

  useEffect(() => {
    const sel = loadGiftSelection();
    if (sel && !sel.attemptId) {
      sel.attemptId = crypto.randomUUID();
      saveGiftSelection(sel);
    }
    setSelection(sel);
  }, []);

  const total = selection?.amountSar ?? 0;
  /** Her wallet credit, signed in and switched on: what it pays, and the rest for the card. */
  const credit = useWalletCredit(total * 100);
  const toPayHalalas = total * 100 - credit.halalas;

  // Paid: back to the builder, which shows the card over itself.
  const issued = (giftCode: string) => {
    clearGiftSelection();
    showPaidOn("/gift-card", "gift_card", { code: giftCode, selection });
  };

  const onPaid = (outcome: PaymentOutcome) => {
    setCheckout(outcome.status === "failed" ? (outcome.checkout ?? null) : null);
    if (outcome.status === "paid" && outcome.result.kind === "gift_card") {
      issued(outcome.result.code as string);
      return;
    }
    const e = outcome.status === "failed" ? outcome.error : "";
    notifyPay(
      declineMessage(c.payDecline, outcome) ??
        (e === "payment-declined" ? c.payDecline.declined : e === "unconfirmed" ? gp.unconfirmed : gp.failed),
    );
  };
  const checkingPayment = usePaymentReturn(onPaid, Boolean(searchParams.paid));

  // Step 2 replaces the page rather than appearing somewhere down it.
  const paying = checkout !== null;
  useEffect(() => {
    if (paying) window.scrollTo({ top: 0, behavior: "smooth" });
  }, [paying]);

  const confirm = async () => {
    if (!selection || submitting) return;
    setSubmitting(true);
    setError(null);
    setPayNotice(null);
    try {
      const res = await fetch("/api/gift-cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountSar: selection.amountSar,
          designId: selection.designId,
          buyerName: selection.senderName || undefined,
          buyerEmail: selection.senderEmail || undefined,
          recipientName: selection.recipientName || undefined,
          recipientEmail: selection.recipientEmail || undefined,
          message: selection.message || undefined,
          lang,
          attemptId: selection.attemptId,
          walletHalalas: credit.halalas || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.checkout) {
        setCheckout(data.checkout);
        return;
      }
      if (res.ok) {
        issued(data.code);
        return;
      }

      // Nothing was issued on a decline, so retrying is safe and cheap.
      // Her credit moved since this page showed it: nothing was charged.
      if (data.error === "wallet-changed") {
        credit.refused(data.walletBalance);
        setError(p.walletChanged);
        return;
      }
      setError(
        data.error === "payment-declined"
          ? c.payDecline.declined
          : data.error === "too-many"
            ? gp.tooMany
            : data.error === "unverified"
              ? gp.unconfirmed
              : gp.failed,
      );
    } catch {
      setError(gp.failed);
    } finally {
      setSubmitting(false);
    }
  };

  const summary = [
    { label: gp.recipient, value: selection?.recipientName || "—" },
    { label: gp.recipientEmail, value: selection?.recipientEmail || "—", ltr: true },
    { label: gp.grandTotal, amount: total },
  ];

  return (
    <main className="relative min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto flex max-w-page justify-center px-6 pt-[112px] md:px-12 lg:justify-start lg:px-16">
        <Steps current={paying ? 2 : 1} labels={[gp.stepDetails, p.stepPay]} />
      </div>

      <div className="mx-auto grid max-w-page gap-6 px-4 pb-24 pt-6 sm:px-6 md:px-12 lg:grid-cols-[1fr_440px] lg:gap-8 lg:px-16">
        {checkout ? (
          <PayStep checkout={checkout} onDone={onPaid} notice={payNotice} sub={gp.paySub} />
        ) : toPayHalalas > 0 ? (
          <PaymentMethods checkout={null} onDone={onPaid} heading={false} />
        ) : (
          // Credit that covers it all leaves nothing for a card.
          <p className="h-fit rounded-[20px] bg-white p-5 text-start text-sm font-semibold text-ink/70">{p.nothingLeft}</p>
        )}

        {/* The card she is buying: above the checkout on a phone, beside it on
            a desktop, so what she pays for never scrolls out of reach. */}
        <aside className="order-first h-fit rounded-[24px] bg-white p-5 text-start shadow-[0_20px_50px_rgba(184,0,7,0.06)] sm:p-6 lg:sticky lg:top-28 lg:order-none">
          <h2 className="mb-5 text-center font-display text-2xl font-extrabold text-ink">
            {gp.summaryTitle}
          </h2>

          <GiftCardArt
            name={selection?.designName}
            img={selection?.designImg}
            amountSar={total}
            recipientName={selection?.recipientName}
            senderName={selection?.senderName}
            message={selection?.message}
            className="shadow-[0_18px_40px_rgba(184,0,7,0.18)]"
          />

          <div className="mt-5 grid grid-cols-2 gap-3">
            {summary.map((r) => (
              <div key={r.label} className="min-w-0 rounded-[14px] border border-black/[0.05] p-4">
                <p className="mb-1 text-[11px] text-ink/45">{r.label}</p>
                {"amount" in r ? (
                  <p className="flex items-center gap-1 font-display text-lg font-extrabold text-ink">
                    <Riyal className="h-4 w-4 text-red" />
                    {r.amount}
                  </p>
                ) : (
                  <p
                    dir={r.ltr ? "ltr" : undefined}
                    className={`break-words text-sm font-semibold text-ink ${r.ltr ? "text-left" : "text-start"}`}
                  >
                    {r.value}
                  </p>
                )}
              </div>
            ))}
          </div>

          {!paying && (
            <>
              {credit.toggle && (
                <div className="mt-4 space-y-2">
                  {credit.toggle}
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
              {(error ?? payNotice) && (
                <p role="alert" className="mt-3 rounded-[12px] bg-red/[0.08] px-4 py-3 text-start text-xs text-red">
                  {error ?? payNotice}
                </p>
              )}

              <button
                type="button"
                onClick={confirm}
                disabled={submitting || !selection || !credit.ok}
                className={`mt-6 block w-full rounded-[12px] py-3.5 text-center text-sm font-bold transition-opacity ${
                  submitting || !selection
                    ? "cursor-not-allowed bg-black/[0.06] text-ink/40"
                    : "bg-red-grad text-white hover:opacity-90"
                }`}
              >
                {submitting ? p.confirming : p.continueToPay}
              </button>
              <p className="mt-3 flex items-center justify-center gap-1.5 text-[12px] text-ink/45">
                <Lock className="h-3.5 w-3.5" />
                {p.secure}
              </p>
            </>
          )}
        </aside>
      </div>

      <SiteFooter />

      {checkingPayment && <CheckingModal />}
      {noticeOpen && payNotice && !checkingPayment && (
        <PayNoticeModal message={payNotice} retry={paying} onClose={() => setNoticeOpen(false)} />
      )}

    </main>
  );
}
