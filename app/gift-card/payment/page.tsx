"use client";

import { useState } from "react";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import PaymentMethods from "@/components/PaymentMethods";
import { Riyal, Lock } from "@/components/icons";
import { useI18n } from "@/lib/i18n";

// Figma: Desktop-2 gift-card payment step (325:7705) + success modal (325:8088).
const TOTAL = 750;

export default function GiftCardPaymentPage() {
  const { c } = useI18n();
  const gp = c.giftPay;
  const p = c.payment;
  const [done, setDone] = useState(false);
  const [method, setMethod] = useState(p.cardTitle);

  const summary = [
    { label: gp.recipient, value: "Sarah Doe" },
    { label: gp.recipientEmail, value: "sarah@example.com", ltr: true },
    { label: gp.sendIn, value: "2026-07-02", ltr: true },
    { label: gp.grandTotal, amount: TOTAL },
  ];

  return (
    <main className="relative min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto grid max-w-page gap-8 px-6 pb-24 pt-[120px] md:px-12 lg:grid-cols-[1fr_540px] lg:px-16">
        <PaymentMethods onConfirm={() => setDone(true)} onMethodChange={setMethod} />

        {/* Summary */}
        <aside className="h-fit rounded-[24px] bg-white p-6 text-start shadow-[0_20px_50px_rgba(184,0,7,0.06)]">
          <h2 className="mb-5 text-center font-display text-2xl font-extrabold text-ink">
            {gp.summaryTitle}
          </h2>

          <img
            src="/gift/card-red.webp"
            alt="Gift card"
            className="w-full rounded-[18px] shadow-[0_18px_40px_rgba(184,0,7,0.18)]"
          />

          <div className="mt-5 grid grid-cols-2 gap-3">
            {summary.map((r) => (
              <div key={r.label} className="rounded-[14px] border border-black/[0.05] p-4">
                <p className="mb-1 text-[11px] text-ink/45">{r.label}</p>
                {"amount" in r ? (
                  <p className="flex items-center gap-1 font-display text-lg font-extrabold text-ink">
                    <Riyal className="h-4 w-4 text-red" />
                    {r.amount}
                  </p>
                ) : (
                  <p
                    dir={r.ltr ? "ltr" : undefined}
                    className={`text-sm font-semibold text-ink ${r.ltr ? "text-left" : "text-start"}`}
                  >
                    {r.value}
                  </p>
                )}
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setDone(true)}
            className="mt-6 block w-full rounded-[12px] bg-red-grad py-3.5 text-center text-sm font-bold text-white transition-opacity hover:opacity-90"
          >
            {p.confirmPay}
          </button>
          <p className="mt-3 flex items-center justify-center gap-1.5 text-[12px] text-ink/45">
            <Lock className="h-3.5 w-3.5" />
            {p.secure}
          </p>
        </aside>
      </div>

      <SiteFooter />

      {done && <SuccessModal method={method} onClose={() => setDone(false)} />}
    </main>
  );
}

function SuccessModal({ method, onClose }: { method: string; onClose: () => void }) {
  const { c } = useI18n();
  const gp = c.giftPay;
  const p = c.payment;
  const rows = [
    { label: gp.to, value: "Sarah@gmail.com", ltr: true },
    { label: gp.from, value: "Khaled" },
    { label: gp.sentIn, value: "2026-07-02", ltr: true },
    { label: gp.method, value: method },
  ];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/30 px-4 py-10 backdrop-blur-sm">
      <div className="w-full max-w-[480px] rounded-[24px] bg-white p-8 text-center shadow-[0_40px_100px_rgba(0,0,0,0.25)]">
        <img src="/pay/success-check.webp" alt="" className="mx-auto mb-5 h-20 w-20" />
        <h3 className="font-display text-2xl font-extrabold text-ink">{gp.successTitle}</h3>
        <p className="mt-2 text-sm text-ink/55">
          {gp.successSubPrefix} <span dir="ltr">Sarah@gmail.com</span>
        </p>

        <img
          src="/gift/card-red.webp"
          alt="Gift card"
          className="mt-6 w-full rounded-[18px] shadow-[0_18px_40px_rgba(184,0,7,0.18)]"
        />

        <div className="mt-5 rounded-[16px] bg-[#f6f6f6] p-5 text-start">
          <p className="mb-3 font-display text-base font-extrabold text-red">{gp.detailsTitle}</p>
          <div className="divide-y divide-black/[0.06]">
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between py-2.5">
                <span className="text-[13px] text-ink/50">{r.label}</span>
                <span dir={r.ltr ? "ltr" : undefined} className="text-[13px] font-semibold text-ink">
                  {r.value}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-6 flex gap-3">
          <Link
            href="/gift-card"
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
