"use client";

import { useState } from "react";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { Riyal } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { pick } from "@/lib/localized";
import { saveGiftSelection } from "@/lib/giftcard-selection";
import type { PublicGiftOptions } from "@/lib/catalog";

// Figma: Desktop-2 node 317:7234 — Gift Card builder. Values and designs are
// managed in /admin/gift-cards rather than hardcoded here.

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[20px] bg-white p-6 shadow-[0_10px_30px_rgba(184,0,7,0.05)]">
      <h2 className="mb-5 text-start font-display text-xl font-extrabold text-ink">{title}</h2>
      {children}
    </div>
  );
}

function DetailField({
  label,
  placeholder,
  type = "text",
  dir,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  type?: string;
  dir: "rtl" | "ltr";
  value?: string;
  onChange?: (v: string) => void;
}) {
  const ltr = type === "email";
  return (
    <label className="block text-start">
      <span className="mb-2 block text-[13px] text-ink/55">{label}</span>
      <input
        type={type}
        dir={ltr ? "ltr" : dir}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        className={`w-full rounded-[12px] border border-black/[0.06] bg-white px-4 py-3.5 text-sm text-ink outline-none placeholder:text-ink/35 focus:border-red/40 ${
          ltr ? "text-left" : "text-start"
        }`}
      />
    </label>
  );
}

export default function GiftCardView({ options }: { options: PublicGiftOptions }) {
  const { c, dir, lang } = useI18n();
  const g = c.gift;
  const { values, designs } = options;
  const [value, setValue] = useState<number>(values[0] ?? 500);
  const [design, setDesign] = useState(0);
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [senderName, setSenderName] = useState("");
  const [message, setMessage] = useState("");

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto grid max-w-page gap-8 px-6 pb-20 pt-[120px] md:px-12 lg:grid-cols-[1fr_460px] lg:px-16">
        {/* Builder */}
        <section className="space-y-6">
          {/* Value */}
          <Panel title={g.valueTitle}>
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
            <p className="mt-5 text-start text-[13px] text-ink/55">{g.customHint}</p>
            <input
              type="number"
              placeholder={g.customPlaceholder}
              onChange={(e) => setValue(Number(e.target.value) || value)}
              className="mt-2 w-full rounded-[12px] border border-black/[0.06] bg-white px-4 py-3.5 text-start text-sm text-ink outline-none placeholder:text-ink/35 focus:border-red/40"
            />
          </Panel>

          {/* Design */}
          <Panel title={g.designTitle}>
            <div dir="ltr" className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {designs.map((d, i) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setDesign(i)}
                  className={`overflow-hidden rounded-[14px] transition-all ${
                    design === i ? "ring-2 ring-red ring-offset-2" : "ring-1 ring-black/[0.06]"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={d.img ?? "/gift/card-red.webp"}
                    alt={pick(d.name, lang)}
                    className="block h-full w-full object-cover"
                  />
                </button>
              ))}
            </div>
          </Panel>

          {/* Details */}
          <Panel title={g.detailsTitle}>
            <div className="grid gap-4 md:grid-cols-2">
              <DetailField
                label={g.recipientEmail}
                placeholder="sarah@example.com"
                type="email"
                dir={dir}
                value={recipientEmail}
                onChange={setRecipientEmail}
              />
              <DetailField
                label={g.recipientName}
                placeholder={g.namePlaceholder}
                dir={dir}
                value={recipientName}
                onChange={setRecipientName}
              />
              <DetailField
                label={g.senderName}
                placeholder={g.senderPlaceholder}
                dir={dir}
                value={senderName}
                onChange={setSenderName}
              />
              <DetailField label={g.sendDate} placeholder="2026-07-02" type="date" dir={dir} />
              <label className="block text-start md:col-span-2">
                <span className="mb-2 block text-[13px] text-ink/55">{g.message}</span>
                <textarea
                  rows={2}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={g.messagePlaceholder}
                  className="w-full resize-none rounded-[12px] border border-black/[0.06] bg-white px-4 py-3 text-start text-sm text-ink outline-none placeholder:text-ink/35 focus:border-red/40"
                />
              </label>
            </div>
          </Panel>
        </section>

        {/* Summary */}
        <aside className="h-fit rounded-[24px] bg-white p-6 shadow-[0_20px_50px_rgba(184,0,7,0.06)]">
          <h2 className="mb-5 text-center font-display text-2xl font-extrabold text-ink">
            {g.summaryTitle}
          </h2>

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={designs[design]?.img ?? "/gift/card-red.webp"}
            alt="Gift card"
            className="w-full rounded-[18px] shadow-[0_18px_40px_rgba(184,0,7,0.18)]"
          />

          <label className="mt-5 flex items-center justify-end gap-2 text-[13px] text-ink/70">
            {g.agree}
            <input type="checkbox" defaultChecked className="h-4 w-4 accent-red" />
          </label>

          <Link
            href="/gift-card/payment"
            onClick={() =>
              saveGiftSelection({
                amountSar: value,
                designId: designs[design]?.id ?? null,
                recipientName,
                recipientEmail,
                senderName,
                message,
              })
            }
            className="mt-4 block w-full rounded-[12px] bg-red-grad py-3.5 text-center text-sm font-bold text-white transition-opacity hover:opacity-90"
          >
            {g.continue}
          </Link>
        </aside>
      </div>

      <SiteFooter />
    </main>
  );
}
