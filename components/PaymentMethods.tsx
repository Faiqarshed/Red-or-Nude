"use client";

import { useState } from "react";

// Shared "اختر طريقة الدفع" panel (card form + mada / STC Pay / Apple Pay).
// Used by the booking and gift-card payment steps.
const otherMethods = [
  { id: "mada", title: "مدى", sub: "بطاقة مدى السعودية" },
  { id: "stc", title: "STC Pay", sub: "الدفع عبر تطبيق STC Pay" },
  { id: "apple", title: "Apple Pay", sub: "" },
] as const;

function Radio({ active }: { active: boolean }) {
  return (
    <span
      className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 ${
        active ? "border-red" : "border-red/40"
      }`}
    >
      {active && <span className="h-3 w-3 rounded-full bg-red" />}
    </span>
  );
}

function MethodLogo({ id }: { id: string }) {
  if (id === "stc")
    return <img src="/pay/stcpay.webp" alt="STC Pay" className="h-6 w-auto" />;
  if (id === "apple")
    return <img src="/pay/apple.webp" alt="Apple Pay" className="h-6 w-auto" />;
  return (
    <span className="rounded-md bg-[#eef3f7] px-2 py-1 text-left leading-none">
      <span className="block text-[10px] font-bold text-[#1a3668]">مدى</span>
      <span className="block text-[12px] font-extrabold tracking-tight">
        <span className="text-[#84bd00]">ma</span>
        <span className="text-[#00a1e0]">da</span>
      </span>
    </span>
  );
}

function Field({
  label,
  placeholder,
  ltr = false,
}: {
  label: string;
  placeholder: string;
  ltr?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-[13px] text-ink/55">{label}</span>
      <input
        dir={ltr ? "ltr" : "rtl"}
        placeholder={placeholder}
        className={`w-full rounded-[12px] border border-black/[0.06] bg-white px-4 py-3.5 text-sm text-ink outline-none placeholder:text-ink/35 focus:border-red/40 ${
          ltr ? "text-left" : "text-right"
        }`}
      />
    </label>
  );
}

export default function PaymentMethods({ onConfirm }: { onConfirm: () => void }) {
  const [method, setMethod] = useState<"card" | "mada" | "stc" | "apple">("card");

  return (
    <section>
      <h2 className="mb-6 text-right font-display text-2xl font-extrabold text-ink">
        اختر طريقة الدفع
      </h2>

      {/* Credit / debit card */}
      <div
        className={`rounded-[20px] p-6 transition-colors ${
          method === "card" ? "bg-[#f9e9e9]" : "bg-white ring-1 ring-black/[0.05]"
        }`}
      >
        <button
          type="button"
          onClick={() => setMethod("card")}
          className="flex w-full items-center justify-between"
        >
          <div className="flex items-center gap-3">
            <img src="/pay/mastercard.webp" alt="Mastercard" className="h-7 w-auto" />
            <div className="text-right">
              <p className="font-display text-base font-bold text-ink">
                بطاقة ائتمانية / خصم
              </p>
              <p className="text-[12px] text-ink/50">Visa, Mastercard</p>
            </div>
          </div>
          <Radio active={method === "card"} />
        </button>

        {method === "card" && (
          <div className="mt-6 space-y-5">
            <Field label="رقم البطاقة" placeholder="1234 5678 9012 3456" ltr />
            <Field label="اسم حامل البطاقة" placeholder="الاسم كما هو مكتوب على البطاقة" />
            <div className="grid grid-cols-2 gap-4">
              <Field label="CVV" placeholder="123" ltr />
              <Field label="تاريخ الانتهاء" placeholder="MM/YY" ltr />
            </div>
            <button
              type="button"
              onClick={onConfirm}
              className="w-full rounded-[12px] bg-red-grad py-4 text-center text-sm font-bold text-white transition-opacity hover:opacity-90"
            >
              تأكيد
            </button>
          </div>
        )}
      </div>

      {/* Other methods */}
      <div className="mt-4 space-y-4">
        {otherMethods.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setMethod(m.id)}
            className={`flex w-full items-center justify-between rounded-[16px] bg-white px-6 py-5 ring-1 transition-colors ${
              method === m.id ? "ring-red/40" : "ring-black/[0.05] hover:ring-red/20"
            }`}
          >
            <div className="flex items-center gap-3">
              <MethodLogo id={m.id} />
              <div className="text-right">
                <p className="font-display text-base font-bold text-ink">{m.title}</p>
                {m.sub && <p className="text-[12px] text-ink/50">{m.sub}</p>}
              </div>
            </div>
            <Radio active={method === m.id} />
          </button>
        ))}
      </div>
    </section>
  );
}
