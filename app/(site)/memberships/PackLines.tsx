"use client";

// What a membership holds, one row per service, each of which opens that service.
//
// Credits are per service, so a line is not a detail — it is the product, and
// "Classic Manicure · 6 sessions" is a promise she cannot judge from a name. The
// row carries the picture and the length; the dialog adds the description, which
// is too long for a card.
//
// One component for the shelf card, the checkout summary and the success panel,
// so the three cannot drift on what a line says.

import { useState } from "react";
import Modal from "@/components/booking/Modal";
import { useI18n } from "@/lib/i18n";
import { pick } from "@/lib/localized";
import { cn } from "@/lib/cn";
import type { PublicPack } from "@/lib/catalog";

type Line = PublicPack["lines"][number];

/**
 * `compact` is the shelf card: one short line per service, so a membership of
 * five or six still fits the card. Checkout and success keep the roomier row.
 */
export default function PackLines({ lines, compact = false }: { lines: Line[]; compact?: boolean }) {
  const { c, lang } = useI18n();
  const k = c.packs;
  const h = c.history;
  const [open, setOpen] = useState<Line | null>(null);

  return (
    <>
      <ul className={compact ? "space-y-0.5" : "space-y-1"}>
        {lines.map((line) => (
          <li key={line.serviceId}>
            {/* `relative z-10` lifts the row above the shelf card's stretched
                link, so a tap here opens the service rather than the checkout. */}
            <button
              type="button"
              onClick={() => setOpen(line)}
              className={cn(
                "relative z-10 -mx-2 flex w-[calc(100%+1rem)] items-center rounded-[12px] px-2 text-start transition-colors hover:bg-cream",
                compact ? "gap-2.5 py-1" : "gap-3 py-1.5",
              )}
            >
              <span
                className={cn(
                  "shrink-0 bg-[#e7d9c9] bg-cover bg-center bg-no-repeat",
                  compact ? "h-6 w-6 rounded-[6px]" : "h-9 w-9 rounded-[8px]",
                )}
                style={line.img ? { backgroundImage: `url(${line.img})` } : undefined}
              />
              {/* Compact puts name and length on one line: the length is a
                  detail, and the dialog behind the row has it again. */}
              <span className={cn("min-w-0 flex-1", compact && "flex items-baseline gap-1.5")}>
                <span className="block truncate text-[13px] text-ink">{pick(line.name, lang)}</span>
                <span className={cn("block text-[11px] text-ink/45", compact && "shrink-0")}>
                  {h.durationMin.replace("{n}", String(line.durationMin))}
                </span>
              </span>
              <span
                className={cn(
                  "shrink-0 font-semibold text-ink",
                  compact ? "text-[12px]" : "text-[13px]",
                )}
              >
                {k.sessions(line.quantity)}
              </span>
              <span aria-hidden className="shrink-0 text-ink/30 rtl:rotate-180">
                ›
              </span>
            </button>
          </li>
        ))}
      </ul>

      {/* The booking details dialog's shape: photo edge to edge, the way out
          pinned below the part that scrolls. */}
      {open && (
        <Modal onClose={() => setOpen(null)} chrome={false} className="max-w-[420px]">
          {open.img && (
            <div
              className="h-44 w-full shrink-0 bg-[#e7d9c9] bg-cover bg-center bg-no-repeat"
              style={{ backgroundImage: `url(${open.img})` }}
            />
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-2 pt-6 text-start">
            <h3 className="font-display text-xl font-extrabold text-ink">{pick(open.name, lang)}</h3>
            <dl className="mt-4 space-y-2">
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-[13px] text-ink/55">{h.durationLabel}</dt>
                <dd className="text-[13px] font-semibold text-ink">
                  {h.durationMin.replace("{n}", String(open.durationMin))}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-[13px] text-ink/55">{k.inMembership}</dt>
                <dd className="text-[13px] font-semibold text-ink">{k.sessions(open.quantity)}</dd>
              </div>
            </dl>
            {open.description && (
              <p className="mt-4 border-t border-black/[0.06] pt-4 text-[13px] leading-relaxed text-ink/65">
                {pick(open.description, lang)}
              </p>
            )}
          </div>
          <div className="shrink-0 p-5">
            <button
              type="button"
              onClick={() => setOpen(null)}
              className="w-full rounded-[12px] bg-black/[0.05] py-3 text-center text-sm font-bold text-ink transition-colors hover:bg-black/[0.08]"
            >
              {c.payment.close}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
