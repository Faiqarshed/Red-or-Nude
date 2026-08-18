"use client";

import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { GiftCardArt } from "@/components/gift/GiftCardArt";
import { Riyal } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { formatDateLabel } from "@/lib/booking";
import type { Localized } from "@/lib/localized";

type Card = {
  code: string;
  amountSar: number;
  balanceSar: number;
  expiresAt: string | null;
  senderName: string | null;
  recipientName: string | null;
  message: string | null;
  designName: Localized | null;
  designImg: string | null;
};

export default function GiftCardReveal({ card }: { card: Card }) {
  const { c, lang } = useI18n();
  const gp = c.giftPay;

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto max-w-[520px] px-6 pb-20 pt-[120px] text-center md:px-12">
        <h1 className="font-display text-3xl font-extrabold text-ink">{gp.cardTitle}</h1>

        <GiftCardArt
          name={card.designName}
          img={card.designImg}
          amountSar={card.amountSar}
          recipientName={card.recipientName ?? undefined}
          senderName={card.senderName ?? undefined}
          message={card.message ?? undefined}
          className="mt-6 shadow-[0_18px_40px_rgba(184,0,7,0.18)]"
        />

        {/* The code is the product — big, selectable, and always LTR. */}
        <p className="mt-6 text-[11px] uppercase tracking-wider text-ink/45">{gp.codeLabel}</p>
        <p
          className="mt-1 inline-block select-all rounded-full bg-white px-6 py-2.5 font-display text-lg font-extrabold tracking-widest text-red shadow-[0_10px_30px_rgba(184,0,7,0.08)]"
          dir="ltr"
        >
          {card.code}
        </p>

        <div className="mt-6 grid grid-cols-2 gap-3 text-start">
          <div className="rounded-[14px] bg-white p-4">
            <p className="mb-1 text-[11px] text-ink/45">{gp.balance}</p>
            <p className="flex items-center gap-1 font-display text-lg font-extrabold text-ink">
              <Riyal className="h-4 w-4 text-red" />
              {card.balanceSar}
            </p>
          </div>
          <div className="rounded-[14px] bg-white p-4">
            <p className="mb-1 text-[11px] text-ink/45">{gp.expires}</p>
            <p className="text-sm font-semibold text-ink">
              {card.expiresAt ? formatDateLabel(card.expiresAt.slice(0, 10), lang) : "—"}
            </p>
          </div>
        </div>

        <p className="mt-5 text-[12px] text-ink/50">{gp.redeemNote}</p>

        <Link
          href="/booking"
          className="mt-6 inline-block rounded-[12px] bg-red-grad px-8 py-3.5 text-sm font-bold text-white transition-opacity hover:opacity-90"
        >
          {c.branch.bookNow}
        </Link>
      </div>

      <SiteFooter />
    </main>
  );
}
