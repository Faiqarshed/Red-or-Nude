"use client";

import { useState } from "react";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import Logo from "@/components/Logo";
import { Riyal } from "@/components/icons";

// Figma: Desktop-2 node 317:7234 — Gift Card page.
const values = [600, 500, 400, 300, 250, 150];

const designs = [
  { label: "", bg: "bg-red-grad", text: "text-white" },
  { label: "Congratulations 🎓", bg: "bg-[#efe7dd]", text: "text-ink" },
  { label: "Happy Birthday", bg: "bg-[#cfe6ef]", text: "text-ink" },
  { label: "Happy Anniversary", bg: "bg-[#e7ddcf]", text: "text-ink" },
];

export default function GiftCardPage() {
  const [value, setValue] = useState(750);
  const [design, setDesign] = useState(0);

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto grid max-w-page gap-8 px-6 pb-20 pt-[120px] md:px-12 lg:grid-cols-[1fr_360px] lg:px-16">
        {/* Selection (right in RTL) */}
        <section className="space-y-6">
          {/* Value */}
          <div className="rounded-[20px] bg-white p-6 shadow-[0_10px_30px_rgba(184,0,7,0.05)]">
            <h2 className="mb-4 text-right font-display text-xl font-extrabold text-ink">
              اختيار قيمة الهدية
            </h2>
            <div className="flex flex-wrap justify-end gap-3">
              {values.map((v) => (
                <button
                  key={v}
                  onClick={() => setValue(v)}
                  className={`flex items-center gap-1 rounded-[12px] border px-6 py-2 font-display font-bold transition-colors ${
                    value === v ? "border-red bg-red text-white" : "border-black/10 text-ink hover:border-red"
                  }`}
                >
                  <Riyal className="h-3.5 w-3.5" />
                  {v}
                </button>
              ))}
            </div>
            <p className="mt-4 text-right text-[12px] text-ink/50">
              أو ادخلي مبلغ مخصص — الحد الأدنى ٩٠ <Riyal className="inline h-3 w-3" /> والحد الأعلى ٢٬٠٠٠
            </p>
            <input
              type="number"
              placeholder="٤٥٠ ريال"
              onChange={(e) => setValue(Number(e.target.value) || value)}
              className="mt-2 w-full rounded-[12px] bg-cream/70 px-4 py-3 text-right text-sm outline-none ring-1 ring-black/[0.06] placeholder:text-ink/40"
            />
          </div>

          {/* Design */}
          <div className="rounded-[20px] bg-white p-6 shadow-[0_10px_30px_rgba(184,0,7,0.05)]">
            <h2 className="mb-4 text-right font-display text-xl font-extrabold text-ink">
              تصميم البطاقة
            </h2>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {designs.map((d, i) => (
                <button
                  key={i}
                  onClick={() => setDesign(i)}
                  className={`flex aspect-[16/10] flex-col justify-between rounded-[14px] p-3 text-right transition-all ${d.bg} ${d.text} ${
                    design === i ? "ring-2 ring-red ring-offset-2" : ""
                  }`}
                >
                  <div className="flex items-center gap-1 font-display text-sm font-extrabold">
                    <Riyal className="h-3 w-3" />
                    {value}
                  </div>
                  <span className="text-[11px] font-semibold">{d.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Details */}
          <div className="rounded-[20px] bg-white p-6 shadow-[0_10px_30px_rgba(184,0,7,0.05)]">
            <h2 className="mb-4 text-right font-display text-xl font-extrabold text-ink">التفاصيل</h2>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="text-right">
                <label className="mb-1 block text-[12px] text-ink/50">بريد المستلم الإلكتروني *</label>
                <input
                  type="email"
                  placeholder="sarah@example.com"
                  className="w-full rounded-[12px] bg-cream/70 px-4 py-3 text-right text-sm outline-none ring-1 ring-black/[0.06] placeholder:text-ink/40"
                />
              </div>
              <div className="text-right">
                <label className="mb-1 block text-[12px] text-ink/50">اسم المستلم *</label>
                <input
                  type="text"
                  placeholder="سارة"
                  className="w-full rounded-[12px] bg-cream/70 px-4 py-3 text-right text-sm outline-none ring-1 ring-black/[0.06] placeholder:text-ink/40"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Summary (left in RTL) */}
        <aside className="h-fit rounded-[24px] bg-white p-6 shadow-[0_20px_50px_rgba(184,0,7,0.06)]">
          <h2 className="mb-5 text-center font-display text-2xl font-extrabold text-ink">
            ملخص بطاقة الهدية
          </h2>

          {/* Preview card */}
          <div className="relative flex aspect-[16/10] flex-col justify-between overflow-hidden rounded-[18px] bg-red-grad p-5 text-white">
            <Logo className="text-[20px]" />
            <div className="flex items-center gap-1 font-display text-5xl font-extrabold">
              <Riyal className="h-8 w-8" />
              {value}
            </div>
            <div className="absolute bottom-5 left-5 text-right text-[11px] leading-5 text-white/85">
              <p>بطاقة هدية</p>
              <p>المناسبة: {designs[design].label || "الحج"}</p>
            </div>
          </div>

          <label className="mt-5 flex items-center justify-end gap-2 text-[12px] text-ink/60">
            أوافق على الشروط والأحكام
            <input type="checkbox" className="h-4 w-4 accent-red" />
          </label>

          <button className="mt-4 w-full rounded-[12px] bg-red-grad py-3 text-sm font-bold text-white transition-opacity hover:opacity-90">
            المتابعة للدفع
          </button>
        </aside>
      </div>

      <SiteFooter />
    </main>
  );
}
