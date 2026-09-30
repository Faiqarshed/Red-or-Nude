"use client";

// The gift card's success popup, shown by /gift-card once the payment page hands
// the code back (lib/paid-handoff.ts). The builder is where "New card" starts,
// so from here it just closes.

import { useState } from "react";
import { GiftCardArt } from "@/components/gift/GiftCardArt";
import { useI18n } from "@/lib/i18n";
import type { GiftSelection } from "@/lib/giftcard-selection";

export default function GiftCardSuccessModal({
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
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-[12px] bg-black/[0.05] py-3.5 text-center text-sm font-bold text-ink transition-colors hover:bg-black/[0.08]"
          >
            {gp.newCard}
          </button>
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
