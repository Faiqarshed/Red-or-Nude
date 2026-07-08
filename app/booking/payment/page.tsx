"use client";

import { useState } from "react";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import PaymentMethods from "@/components/PaymentMethods";
import { Riyal, Lock } from "@/components/icons";

// Figma: Desktop-2 payment step + success modal. Static summary mirrors the
// design; swap for the real booking selection when the schedule step lands.
const summary = [
  { label: "الخدمة", value: "Gel Polish" },
  { label: "الإضافات", value: "Nail Art" },
  { label: "الإزالة", value: "إزالة جل (Gel)" },
  { label: "الموعد", value: "1 يونيو 2026 - اثنين - 1:00 مساءً" },
];
const TOTAL = 220;

export default function PaymentPage() {
  const [done, setDone] = useState(false);

  return (
    <main className="relative min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto grid max-w-page gap-8 px-6 pb-24 pt-[120px] md:px-12 lg:grid-cols-[1fr_540px] lg:px-16">
        <PaymentMethods onConfirm={() => setDone(true)} />

        {/* Summary (left in RTL) */}
        <aside className="h-fit rounded-[24px] bg-white p-6 text-right shadow-[0_20px_50px_rgba(184,0,7,0.06)]">
          <h2 className="mb-5 text-center font-display text-2xl font-extrabold text-ink">
            ملخص الحجز
          </h2>
          <div className="grid grid-cols-2 gap-3">
            {summary.map((r) => (
              <div key={r.label} className="rounded-[14px] border border-black/[0.05] p-4">
                <p className="mb-1 text-[11px] text-ink/45">{r.label}</p>
                <p className="text-sm font-semibold text-ink">{r.value}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-center justify-between rounded-[14px] bg-[#fbeaea] p-4">
            <div className="flex items-center gap-1 font-display text-2xl font-extrabold text-red">
              <Riyal className="h-5 w-5" />
              {TOTAL}
            </div>
            <p className="text-xs text-ink/45">المبلغ الاجمالي</p>
          </div>

          <button
            type="button"
            onClick={() => setDone(true)}
            className="mt-6 block w-full rounded-[12px] bg-red-grad py-3.5 text-center text-sm font-bold text-white transition-opacity hover:opacity-90"
          >
            تأكيد الدفع
          </button>
          <p className="mt-3 flex items-center justify-center gap-1.5 text-[12px] text-ink/45">
            <Lock className="h-3.5 w-3.5" />
            دفع آمن ومشفر
          </p>
        </aside>
      </div>

      <SiteFooter />

      {done && <SuccessModal onClose={() => setDone(false)} />}
    </main>
  );
}

function SuccessModal({ onClose }: { onClose: () => void }) {
  const rows = [
    { label: "الخدمة", value: "Gel Polish" },
    { label: "الأضافات", value: "Nail Art" },
    { label: "ازالة", value: "إزالة جل (Gel)" },
    { label: "التاريخ", value: "16 يونيو 2026" },
    { label: "الوقت", value: "10:30 مساءً" },
    { label: "طريقة الدفع", value: "بطاقة ائتمانية / خصم" },
  ];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 px-4 backdrop-blur-sm">
      <div className="w-full max-w-[460px] rounded-[24px] bg-white p-8 text-center shadow-[0_40px_100px_rgba(0,0,0,0.25)]">
        <img src="/pay/success-check.webp" alt="" className="mx-auto mb-5 h-20 w-20" />
        <h3 className="font-display text-2xl font-extrabold text-ink">تم الحجز بنجاح!</h3>
        <p className="mx-auto mt-2 max-w-[300px] text-sm text-ink/55">
          سيتم إرسال تفاصيل الموعد إلى رقم هاتفك
        </p>

        <div className="mt-6 rounded-[16px] bg-[#f6f6f6] p-5 text-right">
          <p className="mb-3 font-display text-base font-extrabold text-red">تفاصيل الموعد</p>
          <div className="divide-y divide-black/[0.06]">
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between py-2.5">
                <span className="text-[13px] text-ink/50">{r.label}</span>
                <span className="text-[13px] font-semibold text-ink">{r.value}</span>
              </div>
            ))}
            <div className="flex items-center justify-between py-2.5">
              <span className="text-[13px] text-ink/50">المبلغ الإجمالي</span>
              <span className="flex items-center gap-1 font-display text-base font-extrabold text-red">
                <Riyal className="h-4 w-4" />
                {TOTAL}
              </span>
            </div>
          </div>
        </div>

        <div className="mt-6 flex gap-3">
          <Link
            href="/booking"
            className="flex-1 rounded-[12px] bg-black/[0.05] py-3.5 text-center text-sm font-bold text-ink transition-colors hover:bg-black/[0.08]"
          >
            حجز جديد
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-[12px] bg-red-grad py-3.5 text-center text-sm font-bold text-white transition-opacity hover:opacity-90"
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
}
