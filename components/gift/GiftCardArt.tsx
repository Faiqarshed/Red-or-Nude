"use client";

import { Riyal } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import type { Localized } from "@/lib/localized";

// Figma: gift card artwork (Frame 139/183/153/184) — the four SVGs are
// background art (card shape, logo, "بطاقة هدية" badge, occasion icon). The
// occasion title ("Congratulations" etc.) is baked into that art too since
// it's fixed per design; only price and recipient name change per order, so
// only those are rendered as real text on top here.

type Kind = "red" | "congrats" | "birthday" | "anniversary";

const BACKGROUNDS: Record<
  Kind,
  { src: string; ratio: number; textColor: string; subColor: string }
> = {
  red: { src: "/gift/backgrounds/red.svg", ratio: 485 / 260, textColor: "#ffffff", subColor: "#ffffff" },
  congrats: {
    src: "/gift/backgrounds/congrats.svg",
    ratio: 214 / 121,
    textColor: "#3d3d3d",
    subColor: "#767676",
  },
  birthday: {
    src: "/gift/backgrounds/birthday.svg",
    ratio: 210 / 117,
    textColor: "#4f6b78",
    subColor: "#82a0ac",
  },
  anniversary: {
    src: "/gift/backgrounds/anniversary.svg",
    ratio: 210 / 117,
    textColor: "#8a7050",
    subColor: "#ab9678",
  },
};

function kindOf(name: Localized | null | undefined): Kind {
  const en = (name?.en ?? "").toLowerCase();
  if (en.includes("congrat")) return "congrats";
  if (en.includes("birthday")) return "birthday";
  if (en.includes("anniversary")) return "anniversary";
  return "red";
}

export function GiftCardArt({
  name,
  amountSar,
  recipientName,
  senderName,
  message,
  className,
}: {
  name?: Localized | null;
  amountSar: number;
  recipientName?: string;
  senderName?: string;
  message?: string;
  className?: string;
}) {
  const { c } = useI18n();
  const kind = kindOf(name);
  const cfg = BACKGROUNDS[kind];

  return (
    <div
      className={`relative w-full overflow-hidden rounded-[18px] [container-type:inline-size] ${className ?? ""}`}
      style={{ aspectRatio: cfg.ratio }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={cfg.src} alt="" className="absolute inset-0 h-full w-full" />

      {kind === "red" ? (
        <div dir="rtl" className="absolute inset-0" style={{ color: cfg.textColor }}>
          <div className="absolute bottom-[10%] start-[6%] flex items-end gap-[1.4%] font-display text-[15cqw] font-extrabold leading-none">
            <Riyal className="h-[0.6em] w-[0.6em]" />
            <span>{amountSar}</span>
          </div>

          <div className="absolute end-[6%] top-[32%] space-y-[5%] text-end text-[4.6cqw] font-semibold">
            <p>
              {c.giftPay.from}: {senderName || "—"}
            </p>
            <p>
              {c.giftPay.to}: {recipientName || "—"}
            </p>
          </div>

          <p className="absolute end-[6%] top-[73%] max-w-[45%] text-end text-[3.6cqw] italic opacity-90">
            &ldquo;{message || c.gift.messagePlaceholder}&rdquo;
          </p>
        </div>
      ) : (
        <div dir="ltr" className="absolute inset-0">
          <div
            className="absolute start-[7%] top-[33%] flex items-center gap-[1.5%] font-display text-[7cqw] font-extrabold leading-none"
            style={{ color: cfg.textColor }}
          >
            <Riyal className="h-[0.68em] w-[0.68em]" />
            <span>{amountSar}</span>
          </div>
          <p
            className="absolute start-[7%] top-[68%] max-w-[55%] text-[4.8cqw]"
            style={{ color: cfg.subColor }}
          >
            {recipientName || "—"}
          </p>
        </div>
      )}
    </div>
  );
}
