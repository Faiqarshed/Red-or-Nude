"use client";

import { useState } from "react";
import Modal from "./Modal";
import { designs } from "@/lib/booking";
import { useI18n } from "@/lib/i18n";

// "التصاميم الموسمية" seasonal-designs pop-up (Figma 439:11053): a grid of nail
// designs; pick one, then "اختر". Opened by the Seasonal Catalogue add-on.
export default function DesignsModal({
  initialDesign,
  onConfirm,
  onClose,
}: {
  initialDesign: string | null;
  onConfirm: (design: string) => void;
  onClose: () => void;
}) {
  const { c } = useI18n();
  const [choice, setChoice] = useState<string | null>(initialDesign);

  return (
    <Modal title={c.modals.designsTitle} onClose={onClose} className="max-w-[560px]">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {designs.map((d) => {
          const selected = d.name === choice;
          return (
            <button
              key={d.name}
              type="button"
              onClick={() => setChoice(d.name)}
              className={`relative overflow-hidden rounded-[14px] transition-all ${
                selected ? "ring-2 ring-red ring-offset-2" : "ring-1 ring-black/[0.06] hover:ring-red/40"
              }`}
            >
              <div
                className="h-[110px] w-full bg-[#e7d9c9] bg-cover bg-center"
                style={{ backgroundImage: `url(${d.img})` }}
              />
              <span className="absolute bottom-1.5 left-1.5 rounded-full bg-white/95 px-3 py-1 text-[11px] font-semibold text-ink shadow-sm">
                {d.name}
              </span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        disabled={choice === null}
        onClick={() => choice !== null && onConfirm(choice)}
        className={`mt-6 block w-full rounded-[12px] py-3.5 text-center text-sm font-bold transition-colors ${
          choice !== null ? "bg-red-grad text-white hover:opacity-90" : "cursor-not-allowed bg-black/[0.06] text-ink/40"
        }`}
      >
        {c.modals.choose}
      </button>
    </Modal>
  );
}
