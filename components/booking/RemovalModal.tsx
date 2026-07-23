"use client";

import { useState } from "react";
import Modal from "./Modal";
import { useI18n } from "@/lib/i18n";
import { Riyal } from "@/components/icons";
import { pick } from "@/lib/localized";
import type { PublicCatalog } from "@/lib/catalog";

// "هل تحتاجين إزالة؟" (Figma 264:302): Yes/No, then choose a removal type.
// The selection is returned/stored as the removal id.
export default function RemovalModal({
  removals,
  initialRemoval,
  onConfirm,
  onClose,
}: {
  removals: PublicCatalog["removals"];
  initialRemoval: string | null;
  onConfirm: (removal: string | null) => void;
  onClose: () => void;
}) {
  const { c, lang } = useI18n();
  const [needs, setNeeds] = useState<boolean>(initialRemoval !== null);
  const [choice, setChoice] = useState<string | null>(initialRemoval);

  const ready = !needs || choice !== null;

  return (
    <Modal title={c.modals.removalTitle} onClose={onClose} className="max-w-[560px]">
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setNeeds(true)}
          className={`rounded-[14px] py-4 text-center text-sm font-bold transition-colors ${
            needs ? "bg-red-grad text-white" : "text-ink ring-1 ring-black/10 hover:ring-red/40"
          }`}
        >
          {c.modals.yes}
        </button>
        <button
          type="button"
          onClick={() => {
            setNeeds(false);
            setChoice(null);
          }}
          className={`rounded-[14px] py-4 text-center text-sm font-bold transition-colors ${
            !needs ? "bg-red-grad text-white" : "text-ink ring-1 ring-black/10 hover:ring-red/40"
          }`}
        >
          {c.modals.no}
        </button>
      </div>

      {needs && (
        <>
          <p className="mb-3 mt-6 text-start text-[13px] text-ink/55">{c.modals.chooseRemoval}</p>
          <div className="space-y-3">
            {removals.map((r) => {
              const selected = r.id === choice;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setChoice(r.id)}
                  className={`flex w-full items-center justify-between rounded-[14px] px-5 py-4 transition-colors ${
                    selected ? "bg-[#f9e9e9] ring-2 ring-red" : "ring-1 ring-black/10 hover:ring-red/40"
                  }`}
                >
                  <span className="flex items-center gap-1 rounded-full bg-[#f7e8e8] px-3 py-1 text-[12px] font-bold text-ink">
                    <Riyal className="h-3 w-3 text-red" />
                    {r.price}
                  </span>
                  <span className="text-sm font-semibold text-ink">{pick(r.name, lang)}</span>
                </button>
              );
            })}
          </div>
        </>
      )}

      <button
        type="button"
        disabled={!ready}
        onClick={() => onConfirm(needs ? choice : null)}
        className={`mt-8 block w-full rounded-[12px] py-3.5 text-center text-sm font-bold transition-colors ${
          ready ? "bg-red-grad text-white hover:opacity-90" : "cursor-not-allowed bg-black/[0.06] text-ink/40"
        }`}
      >
        {c.modals.confirm}
      </button>
    </Modal>
  );
}
