"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { Riyal } from "@/components/icons";
import { GiftCardArt } from "@/components/gift/GiftCardArt";
import TextInput from "@/components/TextInput";
import {
  EMAIL_MAX,
  EMAIL_TEXT,
  PERSON_NAME_MAX,
  PERSON_TEXT,
  checkEmail,
  checkNote,
  checkPersonName,
  collect,
  focusFirstInvalid,
  hasErrors,
} from "@/lib/admin/validate";
import { validationMessages } from "@/lib/validation-messages";
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

const MESSAGE_MAX = 500;

export default function GiftCardView({ options }: { options: PublicGiftOptions }) {
  const router = useRouter();
  const { c, lang } = useI18n();
  const g = c.gift;
  const { values, designs } = options;
  const [value, setValue] = useState<number>(values[0] ?? 500);
  const [design, setDesign] = useState(0);
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [senderName, setSenderName] = useState("");
  const [senderEmail, setSenderEmail] = useState("");
  const [message, setMessage] = useState("");
  const [agreed, setAgreed] = useState(true);
  /** Errors show once Continue has been pressed, then clear as each is fixed. */
  const [tried, setTried] = useState(false);

  // The checks POST /api/gift-cards runs, said before she leaves the page.
  const v = validationMessages[lang];
  const errors = collect({
    recipientEmail: checkEmail(v, g.recipientEmail, recipientEmail),
    recipientName: checkPersonName(v, g.recipientName, recipientName),
    senderName: checkPersonName(v, g.senderName, senderName, { required: false }),
    senderEmail: checkEmail(v, g.senderEmail, senderEmail),
    message: checkNote(v, g.message, message, { required: false, max: MESSAGE_MAX }),
    agree: !agreed && g.mustAgree,
  });

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
              <TextInput
                label={`${g.recipientName} *`}
                placeholder={g.namePlaceholder}
                value={recipientName}
                onChange={setRecipientName}
                opts={PERSON_TEXT}
                max={PERSON_NAME_MAX}
                error={errors.recipientName}
                showError={tried}
              />
              <TextInput
                label={g.recipientEmail}
                placeholder="sarah@example.com"
                value={recipientEmail}
                onChange={setRecipientEmail}
                opts={EMAIL_TEXT}
                max={EMAIL_MAX}
                error={errors.recipientEmail}
                showError={tried}
              />
              <TextInput
                label={g.senderName}
                placeholder={g.senderPlaceholder}
                value={senderName}
                onChange={setSenderName}
                opts={PERSON_TEXT}
                max={PERSON_NAME_MAX}
                error={errors.senderName}
                showError={tried}
              />
              {/* The buyer's copy of the code. Without it, the code lives only in
                  the success screen, and a closed tab loses it. */}
              <TextInput
                label={g.senderEmail}
                placeholder="you@example.com"
                value={senderEmail}
                onChange={setSenderEmail}
                opts={EMAIL_TEXT}
                max={EMAIL_MAX}
                error={errors.senderEmail}
                showError={tried}
                hint={g.senderEmailHint}
              />
              <label className="block text-start md:col-span-2">
                <span className="mb-2 block text-[13px] text-ink/55">{g.message}</span>
                <textarea
                  rows={2}
                  value={message}
                  onChange={(e) => setMessage(e.target.value.slice(0, MESSAGE_MAX))}
                  maxLength={MESSAGE_MAX}
                  placeholder={g.messagePlaceholder}
                  aria-invalid={tried && errors.message ? true : undefined}
                  className={`w-full resize-none rounded-[12px] border bg-white px-4 py-3 text-start text-sm text-ink outline-none placeholder:text-ink/35 ${
                    tried && errors.message ? "border-red/60" : "border-black/[0.06] focus:border-red/40"
                  }`}
                />
                <span className="mt-1 flex justify-between gap-3 text-[11px]">
                  <span className="text-red">{tried && errors.message}</span>
                  <span className="text-ink/40" dir="ltr">
                    {message.length} / {MESSAGE_MAX}
                  </span>
                </span>
              </label>
            </div>
          </Panel>
        </section>

        {/* Summary */}
        <aside className="h-fit rounded-[24px] bg-white p-6 shadow-[0_20px_50px_rgba(184,0,7,0.06)]">
          <h2 className="mb-5 text-center font-display text-2xl font-extrabold text-ink">
            {g.summaryTitle}
          </h2>

          <GiftCardArt
            name={designs[design]?.name}
            img={designs[design]?.img}
            amountSar={value}
            recipientName={recipientName}
            senderName={senderName}
            message={message}
            className="shadow-[0_18px_40px_rgba(184,0,7,0.18)]"
          />

          <label className="mt-5 flex items-center justify-end gap-2 text-[13px] text-ink/70">
            {g.agree}
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              aria-invalid={tried && errors.agree ? true : undefined}
              className="h-4 w-4 accent-red"
            />
          </label>
          {tried && hasErrors(errors) && (
            <p role="alert" className="mt-3 rounded-[12px] bg-red/[0.08] px-4 py-3 text-start text-xs text-red">
              {Object.values(errors)[0]}
            </p>
          )}

          <button
            type="button"
            onClick={() => {
              setTried(true);
              if (hasErrors(errors)) {
                focusFirstInvalid();
                return;
              }
              saveGiftSelection({
                amountSar: value,
                designId: designs[design]?.id ?? null,
                designName: designs[design]?.name ?? null,
                designImg: designs[design]?.img ?? null,
                recipientName,
                recipientEmail,
                senderName,
                senderEmail,
                message,
              });
              router.push("/gift-card/payment");
            }}
            className="mt-4 block w-full rounded-[12px] bg-red-grad py-3.5 text-center text-sm font-bold text-white transition-opacity hover:opacity-90"
          >
            {g.continue}
          </button>
        </aside>
      </div>

      <SiteFooter />
    </main>
  );
}
