"use client";

import { useState } from "react";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { Riyal } from "@/components/icons";

// Figma: Desktop-2 node 317:7234 — Gift Card builder.
const values = [600, 500, 400, 300, 250, 150];
const designs = [
  { src: "/gift/design-red.webp", alt: "بطاقة حمراء" },
  { src: "/gift/design-congrats.webp", alt: "Congratulations" },
  { src: "/gift/design-birthday.webp", alt: "Happy Birthday" },
  { src: "/gift/design-anniversary.webp", alt: "Happy Anniversary" },
];

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[20px] bg-white p-6 shadow-[0_10px_30px_rgba(184,0,7,0.05)]">
      <h2 className="mb-5 text-right font-display text-xl font-extrabold text-ink">{title}</h2>
      {children}
    </div>
  );
}

function DetailField({
  label,
  placeholder,
  type = "text",
}: {
  label: string;
  placeholder: string;
  type?: string;
}) {
  return (
    <label className="block text-right">
      <span className="mb-2 block text-[13px] text-ink/55">{label}</span>
      <input
        type={type}
        dir={type === "email" ? "ltr" : "rtl"}
        placeholder={placeholder}
        className={`w-full rounded-[12px] border border-black/[0.06] bg-white px-4 py-3.5 text-sm text-ink outline-none placeholder:text-ink/35 focus:border-red/40 ${
          type === "email" ? "text-left" : "text-right"
        }`}
      />
    </label>
  );
}

export default function GiftCardPage() {
  const [value, setValue] = useState<number>(750);
  const [design, setDesign] = useState(0);

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto grid max-w-page gap-8 px-6 pb-20 pt-[120px] md:px-12 lg:grid-cols-[1fr_460px] lg:px-16">
        {/* Builder (right in RTL) */}
        <section className="space-y-6">
          {/* Value */}
          <Panel title="اختيار قيمة الهدية">
            <div dir="ltr" className="grid grid-cols-3 gap-3 sm:grid-cols-6">
              {values.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setValue(v)}
                  className={`flex items-center justify-center gap-1 rounded-[12px] border py-3 font-display font-bold transition-colors ${
                    value === v
                      ? "border-red bg-red text-white"
                      : "border-black/10 text-ink hover:border-red"
                  }`}
                >
                  <Riyal className="h-3.5 w-3.5" />
                  {v}
                </button>
              ))}
            </div>
            <p className="mt-5 flex items-center justify-end gap-1 text-right text-[13px] text-ink/55">
              أو أدخلي مبلغاً مخصصاً (الحد الأدنى 50 <Riyal className="inline h-3 w-3" /> - الحد الأعلى
              2,000 <Riyal className="inline h-3 w-3" /> )
            </p>
            <input
              type="number"
              placeholder="مثلاً 450"
              onChange={(e) => setValue(Number(e.target.value) || value)}
              className="mt-2 w-full rounded-[12px] border border-black/[0.06] bg-white px-4 py-3.5 text-right text-sm text-ink outline-none placeholder:text-ink/35 focus:border-red/40"
            />
          </Panel>

          {/* Design */}
          <Panel title="تصميم البطاقة">
            <div dir="ltr" className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {designs.map((d, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setDesign(i)}
                  className={`overflow-hidden rounded-[14px] transition-all ${
                    design === i ? "ring-2 ring-red ring-offset-2" : "ring-1 ring-black/[0.06]"
                  }`}
                >
                  <img src={d.src} alt={d.alt} className="block h-full w-full object-cover" />
                </button>
              ))}
            </div>
          </Panel>

          {/* Details */}
          <Panel title="التفاصيل">
            <div className="grid gap-4 md:grid-cols-2">
              <DetailField label="بريد المستلمة الإلكتروني *" placeholder="sarah@example.com" type="email" />
              <DetailField label="اسم المستلمة *" placeholder="سارة" />
              <DetailField label="اسمك (المرسل)" placeholder="خالد" />
              <DetailField label="تاريخ الإرسال" placeholder="2026-07-02" type="date" />
              <label className="block text-right md:col-span-2">
                <span className="mb-2 block text-[13px] text-ink/55">رسالة قصيرة</span>
                <textarea
                  rows={2}
                  placeholder="تستاهلين الدلع"
                  className="w-full resize-none rounded-[12px] border border-black/[0.06] bg-white px-4 py-3 text-right text-sm text-ink outline-none placeholder:text-ink/35 focus:border-red/40"
                />
              </label>
            </div>
          </Panel>
        </section>

        {/* Summary (left in RTL) */}
        <aside className="h-fit rounded-[24px] bg-white p-6 shadow-[0_20px_50px_rgba(184,0,7,0.06)]">
          <h2 className="mb-5 text-center font-display text-2xl font-extrabold text-ink">
            ملخص بطاقة الهدية
          </h2>

          <img
            src="/gift/card-red.webp"
            alt="بطاقة هدية"
            className="w-full rounded-[18px] shadow-[0_18px_40px_rgba(184,0,7,0.18)]"
          />

          <label className="mt-5 flex items-center justify-end gap-2 text-[13px] text-ink/70">
            أوافق على الشروط والأحكام
            <input type="checkbox" defaultChecked className="h-4 w-4 accent-red" />
          </label>

          <Link
            href="/gift-card/payment"
            className="mt-4 block w-full rounded-[12px] bg-red-grad py-3.5 text-center text-sm font-bold text-white transition-opacity hover:opacity-90"
          >
            المتابعة للدفع
          </Link>
        </aside>
      </div>

      <SiteFooter />
    </main>
  );
}
