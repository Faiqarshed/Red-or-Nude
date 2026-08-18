"use client";

// Which salon. Shared by /booking and /booking/group — a group is one booking at
// one branch, so there is never more than one of these on a page.
//
// Hidden when there is only one branch to choose from.

import { useI18n } from "@/lib/i18n";
import type { PublicBranch } from "@/lib/catalog";

export default function BranchPicker({
  branches,
  value,
  onChange,
}: {
  branches: PublicBranch[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  const { c } = useI18n();
  if (branches.length < 2) return null;

  return (
    <div>
      <h2 className="mb-5 text-start font-display text-2xl font-extrabold text-ink">
        {c.modals.branchTitle}
      </h2>
      <div className="flex flex-wrap gap-3">
        {branches.map((br) => (
          <button
            key={br.id}
            type="button"
            onClick={() => onChange(br.id)}
            className={`rounded-[14px] px-5 py-3 text-sm transition-all ${
              value === br.id
                ? "bg-red font-bold text-white shadow-[0_8px_20px_rgba(184,0,7,0.2)]"
                : "bg-white text-ink ring-1 ring-black/[0.06] hover:ring-red/40"
            }`}
          >
            {br.name}
          </button>
        ))}
      </div>
    </div>
  );
}
