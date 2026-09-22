"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import PaymentMethods from "@/components/PaymentMethods";
import { declineMessage, usePaymentReturn, type PaymentOutcome } from "@/components/StreamPayCheckout";
import { CheckingModal, PayNoticeModal, PayStep, Steps } from "@/components/PayFlow";
import { GiftCardArt } from "@/components/gift/GiftCardArt";
import { Riyal, Lock } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { clearGiftSelection, loadGiftSelection, type GiftSelection } from "@/lib/giftcard-selection";

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
  const router = useRouter();
  const gp = c.giftPay;
  const p = c.payment;
  const [selection, setSelection] = useState<GiftSelection | null>(null);
  const [code, setCode] = useState<string | null>(null);
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
    setSelection(loadGiftSelection());
  }, []);

  const total = selection?.amountSar ?? 0;

  const issued = (giftCode: string) => {
    setCode(giftCode);
    clearGiftSelection();
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
      setError(data.error === "payment-declined" ? c.payDecline.declined : gp.failed);
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
        ) : (
          <PaymentMethods checkout={null} onDone={onPaid} heading={false} />
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
              {(error ?? payNotice) && (
                <p role="alert" className="mt-3 rounded-[12px] bg-red/[0.08] px-4 py-3 text-start text-xs text-red">
                  {error ?? payNotice}
                </p>
              )}

              <button
                type="button"
                onClick={confirm}
                disabled={submitting || !selection}
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

      {code && (
        <SuccessModal
          code={code}
          selection={selection}
          // Paid for: closing leaves for the home page, as a booking does.
          // replace, so Back can't land on a checkout she has already paid.
          onClose={() => router.replace("/")}
        />
      )}
    </main>
  );
}

function SuccessModal({
  code,
  selection,
  onClose,
}: {
  code: string;
  selection: GiftSelection | null;
  onClose: () => void;
}) {
  const { c } = useI18n();
  const gp = c.giftPay;
  const p = c.payment;
  const [copied, setCopied] = useState(false);

  // Built on the client so it carries whatever host the buyer is actually on —
  // localhost in development, the real domain in production.
  const link = typeof window === "undefined" ? `/gift/${code}` : `${window.location.origin}/gift/${code}`;
  // The occasion message first, then the card itself.
  const text = [
    selection?.message,
    gp.whatsappText
      .replace("{amount}", String(selection?.amountSar ?? 0))
      .replace("{link}", link),
  ]
    .filter(Boolean)
    .join("\n\n");

  // No number: WhatsApp asks who to send it to, so she can share it with anyone.
  const waHref = `https://wa.me/?text=${encodeURIComponent(text)}`;

  const rows = [
    { label: gp.to, value: selection?.recipientName || selection?.recipientEmail || "—" },
    { label: gp.from, value: selection?.senderName || "—" },
  ];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/30 px-4 py-10 backdrop-blur-sm">
      <div className="w-full max-w-[480px] rounded-[24px] bg-white p-8 text-center shadow-[0_40px_100px_rgba(0,0,0,0.25)]">
        <img src="/pay/success-check.webp" alt="" className="mx-auto mb-5 h-20 w-20" />
        <h3 className="font-display text-2xl font-extrabold text-ink">{gp.successTitle}</h3>
        <p className="mt-2 text-sm text-ink/55">{gp.shareHint}</p>

        {/* The delivery step. A plain link, so it works on every phone with no
            API key, no approved template and no provider account. */}
        <a
          href={waHref}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-[12px] bg-[#25d366] py-3.5 text-sm font-bold text-white transition-opacity hover:opacity-90"
        >
          {gp.sendWhatsapp}
        </a>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(link);
            setCopied(true);
          }}
          className="mt-2 text-[12px] font-semibold text-ink/50 underline underline-offset-4 hover:text-red"
        >
          {copied ? gp.copied : gp.copyLink}
        </button>

        {/* The redeemable code — this is the actual product. */}
        <p
          className="mt-4 inline-block rounded-full bg-[#f6f6f6] px-5 py-2 font-display text-lg font-extrabold tracking-wider text-red"
          dir="ltr"
        >
          {code}
        </p>

        <GiftCardArt
          name={selection?.designName}
          img={selection?.designImg}
          amountSar={selection?.amountSar ?? 0}
          recipientName={selection?.recipientName}
          senderName={selection?.senderName}
          message={selection?.message}
          className="mt-6 shadow-[0_18px_40px_rgba(184,0,7,0.18)]"
        />

        <div className="mt-5 rounded-[16px] bg-[#f6f6f6] p-5 text-start">
          <p className="mb-3 font-display text-base font-extrabold text-red">{gp.detailsTitle}</p>
          <div className="divide-y divide-black/[0.06]">
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between py-2.5">
                <span className="text-[13px] text-ink/50">{r.label}</span>
                <span className="text-[13px] font-semibold text-ink">
                  {r.value}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-6 flex gap-3">
          <Link
            href="/gift-card"
            replace
            className="flex-1 rounded-[12px] bg-black/[0.05] py-3.5 text-center text-sm font-bold text-ink transition-colors hover:bg-black/[0.08]"
          >
            {gp.newCard}
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-[12px] bg-red-grad py-3.5 text-center text-sm font-bold text-white transition-opacity hover:opacity-90"
          >
            {p.close}
          </button>
        </div>
      </div>
    </div>
  );
}
