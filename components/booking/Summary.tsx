"use client";

// The right-hand booking summary, shared by /booking and /booking/group.
//
// It takes the frozen MemberSelection list rather than raw picker state, so it
// renders one guest or two from exactly the data that gets posted — the panel
// and the API can't disagree about what was ordered.

import { Riyal } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import type { MemberSelection } from "@/lib/booking";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[14px] bg-cream/70 p-4 text-start ring-1 ring-black/[0.04]">
      <p className="mb-1 text-[11px] text-ink/45">{label}</p>
      <p className="text-sm font-semibold text-ink">{value}</p>
    </div>
  );
}

export default function Summary({
  members,
  appointment,
  onEditSchedule,
  grossTotal,
  total,
  agree,
  onAgree,
  ready,
  onProceed,
}: {
  members: MemberSelection[];
  appointment: string;
  onEditSchedule: () => void;
  grossTotal: number;
  /** After the group discount. Equal to grossTotal for a single guest. */
  total: number;
  agree: boolean;
  onAgree: (v: boolean) => void;
  ready: boolean;
  onProceed: () => void;
}) {
  const { c } = useI18n();
  const b = c.booking;
  const discounted = total < grossTotal;

  return (
    <aside className="h-fit rounded-[24px] bg-white p-6 text-start shadow-[0_20px_50px_rgba(184,0,7,0.06)]">
      <h2 className="mb-5 text-center font-display text-2xl font-extrabold text-ink">
        {b.summaryTitle}
      </h2>

      <div className="space-y-4">
        {members.map((m, i) => (
          <div key={i}>
            {members.length > 1 && (
              <p className="mb-2 text-start font-display text-sm font-extrabold text-red">
                {i === 0 ? b.guest1 : b.guest2}
              </p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Row label={b.service} value={m.service ?? b.notSelected} />
              <Row label={b.addons} value={m.addons.length ? m.addons.join("، ") : b.none} />
              <Row label={b.removal} value={m.removal ?? b.none} />
              <div className="rounded-[14px] bg-cream/70 p-4 text-start ring-1 ring-black/[0.04]">
                <p className="mb-1 text-[11px] text-ink/45">{b.total}</p>
                <p className="flex items-center gap-1 text-sm font-semibold text-ink">
                  <Riyal className="h-3.5 w-3.5 text-red" />
                  {m.price}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* One appointment for everyone on the bill. */}
      <button
        type="button"
        onClick={onEditSchedule}
        className="mt-4 w-full rounded-[14px] bg-cream/70 p-4 text-start ring-1 ring-black/[0.04] transition-colors hover:ring-red/40"
      >
        <p className="mb-1 text-[11px] text-ink/45">{b.appointment}</p>
        <p className="text-sm font-semibold text-ink">{appointment}</p>
      </button>
      {members.length > 1 && (
        <p className="mt-2 text-start text-[11px] text-ink/45">{b.sameSlotNote}</p>
      )}

      {discounted && (
        <div className="mt-4 space-y-1.5 rounded-[14px] bg-cream/50 p-4 text-[13px]">
          <div className="flex items-center justify-between text-ink/55">
            <span className="flex items-center gap-1">
              <Riyal className="h-3 w-3" />
              {grossTotal}
            </span>
            <span>{b.subtotal}</span>
          </div>
          <div className="flex items-center justify-between font-semibold text-red">
            <span className="flex items-center gap-1">
              −<Riyal className="h-3 w-3" />
              {grossTotal - total}
            </span>
            <span>{b.groupDiscount}</span>
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between rounded-[14px] bg-[#fbeaea] p-4">
        <div className="flex items-center gap-1 font-display text-2xl font-extrabold text-red">
          <Riyal className="h-5 w-5" />
          {total}
        </div>
        <p className="text-xs text-ink/45">{b.total}</p>
      </div>

      <label className="mt-4 flex items-center justify-end gap-2 text-[12px] text-ink/60">
        {b.agree}
        <input
          type="checkbox"
          checked={agree}
          onChange={(e) => onAgree(e.target.checked)}
          className="h-4 w-4 accent-red"
        />
      </label>

      <button
        type="button"
        onClick={onProceed}
        disabled={!ready}
        className={`mt-4 block w-full rounded-[12px] py-3 text-center text-sm font-bold transition-colors ${
          ready
            ? "bg-red-grad text-white hover:opacity-90"
            : "cursor-not-allowed bg-black/[0.06] text-ink/40"
        }`}
      >
        {b.complete}
      </button>
    </aside>
  );
}
