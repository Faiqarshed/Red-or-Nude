"use client";

// The membership's success popup, shown by /memberships once the payment page
// hands the pack back (lib/paid-handoff.ts). What she has, until when, and how
// to spend it — "Bought" alone left her to guess all three. No receipt step: the
// credits are already on her account by the time this renders.

import { useEffect } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { pick } from "@/lib/localized";
import { formatDateLabel } from "@/lib/booking";
import type { PublicPack } from "@/lib/catalog";
import PackLines from "./PackLines";

export default function PackBoughtModal({
  pack,
  boughtAt,
  onClose,
}: {
  pack: PublicPack;
  boughtAt: number;
  onClose: () => void;
}) {
  const { c, lang } = useI18n();
  const k = c.packs;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="presentation"
      onClick={onClose}
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/30 px-4 py-10 backdrop-blur-sm"
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[460px] rounded-[24px] bg-white p-8 text-center shadow-[0_40px_100px_rgba(0,0,0,0.25)]"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/pay/success-check.webp" alt="" className="mx-auto mb-5 h-20 w-20" />
        <h3 className="font-display text-2xl font-extrabold text-ink">{k.bought}</h3>
        <p className="mt-1 font-display text-base font-extrabold text-red">{pick(pack.name, lang)}</p>

        <div className="mt-5 rounded-[16px] bg-[#fbeaea] p-5 text-start">
          <PackLines lines={pack.lines} />
          {/* Counted the way buyPack counts it, and sliced to a UTC date the way
              the account page slices expiresAt, so the two screens name the
              same day. */}
          <p className="mt-2 text-[12px] text-ink/55">
            {k.expiresOn.replace(
              "{date}",
              formatDateLabel(new Date(boughtAt + pack.validDays * 86_400_000).toISOString().slice(0, 10), lang),
            )}
          </p>
          <p className="mt-3 text-[13px] leading-relaxed text-ink/65">{k.boughtNote}</p>
        </div>

        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-[12px] bg-black/[0.05] py-3.5 text-center text-sm font-bold text-ink transition-colors hover:bg-black/[0.08]"
          >
            {c.payment.close}
          </button>
          <Link
            href="/booking"
            className="flex-1 rounded-[12px] bg-red-grad py-3.5 text-center text-sm font-bold text-white transition-opacity hover:opacity-90"
          >
            {k.bookNow}
          </Link>
        </div>
        <Link
          href="/account"
          className="mt-4 inline-block text-[12px] font-semibold text-red underline underline-offset-4"
        >
          {k.seeAccount}
        </Link>
      </div>
    </div>
  );
}
