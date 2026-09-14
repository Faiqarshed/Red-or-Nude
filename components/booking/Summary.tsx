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
  onEditMember,
  grossTotal,
  total,
  credit,
  creditNote,
  agree,
  onAgree,
  ready,
  onProceed,
}: {
  members: MemberSelection[];
  appointment: string;
  /**
   * Omitted where the appointment is not this panel's to change — the group
   * page, where each guest picks her own in her own panel. Without it the row
   * renders as a plain line: the same idiom as Card in GuestPicker, and for the
   * same reason. A button that opens a picker for something already picked four
   * times over is not a shortcut, it is a question nobody asked.
   */
  onEditSchedule?: () => void;
  /**
   * Open guest `i`'s time picker. Given by the group page, where each guest has
   * her own hour: they live here rather than one-per-accordion-panel so all four
   * can be read at once, beside the price, instead of by opening four drawers.
   *
   * Her branch stays in her panel, with the services — it decides which chairs
   * and which hours exist, so it belongs next to the thing it constrains.
   */
  onEditMember?: (i: number) => void;
  grossTotal: number;
  /** After the group discount. Equal to grossTotal for a single guest. */
  total: number;
  /**
   * A membership credit she holds for the service she picked, or null.
   *
   * It lives beside the total rather than down in the form, because it is a
   * price control and the price is here. It was a checkbox under the removal
   * picker, four screens down, and a customer who had bought a membership had to
   * go looking for the thing she had already paid for.
   *
   * `applied` starts true, so she does not have to find it at all — the total is
   * already right when the panel first renders, and this row is how she *un*does
   * that. Spending a credit is what buying one was for; saving it for a dearer
   * visit is the rarer intent, and rarer intents get the click.
   */
  credit?: {
    /** Which membership, and what is left on it. */
    label: string;
    /** What it takes off, in riyals. */
    amount: number;
    applied: boolean;
    onToggle: (applied: boolean) => void;
  } | null;
  /**
   * Said in the credit row's place when she holds credits but none for this
   * service. A member who picks a service and sees no credit row otherwise
   * cannot tell "not covered" from "something broke".
   */
  creditNote?: string | null;
  agree: boolean;
  onAgree: (v: boolean) => void;
  ready: boolean;
  onProceed: () => void;
}) {
  const { c } = useI18n();
  const b = c.booking;
  const discounted = total < grossTotal;
  // A party whose guests hold their own hours shares only the day, and calling
  // that row "Appointment" while it shows a date and no time reads as a half
  // filled-in field. It is not: it is the day, and each guest's own time is on
  // her own line above.
  const perGuestTimes = members.some((m) => m.timeLabel);

  return (
    // Sticky, so the price and everything that moves it stay on screen while
    // she works down a page of services and add-ons. `h-fit` is what makes that
    // possible in a grid: a stretched item is as tall as the row and has nothing
    // to scroll within.
    <aside className="h-fit rounded-[24px] bg-white p-6 text-start shadow-[0_20px_50px_rgba(184,0,7,0.06)] lg:sticky lg:top-[110px]">
      <h2 className="mb-5 text-center font-display text-2xl font-extrabold text-ink">
        {b.summaryTitle}
      </h2>

      <div className="space-y-4">
        {members.map((m, i) => (
          <div key={i}>
            {members.length > 1 && (
              <p className="mb-2 text-start font-display text-sm font-extrabold text-red">
                {b.guestN.replace("{n}", String(i + 1))}
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

            {/* Where and when *she* sits. A group of four spread over two
                salons and four hours is otherwise four identical-looking lines
                on one bill.

                Not offered until she has a service: the calendar is asked for
                the duration her services add up to, so picking an hour first
                would be picking against a length that is about to change. */}
            {onEditMember ? (
              <button
                type="button"
                // `disabled` rather than swapping the tag for a div: the browser
                // takes it out of the tab order and tells a screen reader why,
                // which a greyed div does neither of.
                disabled={m.service === null}
                onClick={() => onEditMember(i)}
                className="mt-2 flex w-full items-center justify-between gap-3 rounded-[12px] bg-cream/70 px-3 py-2.5 text-start text-[12px] text-ink/70 ring-1 ring-black/[0.04] transition-colors hover:ring-red/40 disabled:bg-black/[0.02] disabled:text-ink/30 disabled:ring-black/[0.03] disabled:hover:ring-black/[0.03]"
              >
                <span className="truncate">
                  {/* Says why, not just that it is off. Greyed with her branch
                      on it reads as the branch being the problem, which is the
                      one thing it is not. */}
                  {m.service === null
                    ? b.pickServiceFirst
                    : [m.branch, m.timeLabel].filter(Boolean).join(" · ") || b.notSelected}
                </span>
                {m.service !== null && (
                  <span className="shrink-0 text-red">{m.timeLabel ? "✎" : "+"}</span>
                )}
              </button>
            ) : (m.timeLabel || m.branch) ? (
              <p className="mt-2 text-start text-[12px] text-ink/55">
                {[m.branch, m.timeLabel].filter(Boolean).join(" · ")}
              </p>
            ) : null}
          </div>
        ))}
      </div>

      {/* The day, for everyone on the bill. In a group each guest may hold her
          own branch and hour, and those live in her own panel — this row is
          what they have in common. */}
      {(() => {
        const Tag = onEditSchedule ? "button" : "div";
        return (
          <Tag
            onClick={onEditSchedule}
            className={`mt-4 w-full rounded-[14px] bg-cream/70 p-4 text-start ring-1 ring-black/[0.04] ${
              onEditSchedule ? "transition-colors hover:ring-red/40" : ""
            }`}
          >
            <p className="mb-1 text-[11px] text-ink/45">
              {perGuestTimes ? b.groupDay : b.appointment}
            </p>
            <p className="text-sm font-semibold text-ink">{appointment}</p>
          </Tag>
        );
      })()}
      {members.length > 1 && perGuestTimes && (
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

      {/* The membership credit, as a row of the bill rather than a form field
          somewhere above it. Reads as applied, because it is. */}
      {credit && (
        <label
          className={`mt-4 flex cursor-pointer items-center justify-between gap-3 rounded-[14px] p-4 text-start ring-1 transition-all ${
            credit.applied
              ? "bg-[#fbeaea] ring-red/30"
              : "bg-cream/50 ring-black/[0.04] hover:ring-red/40"
          }`}
        >
          <span className="flex min-w-0 items-center gap-3">
            <input
              type="checkbox"
              checked={credit.applied}
              onChange={(e) => credit.onToggle(e.target.checked)}
              className="h-4 w-4 shrink-0 accent-red"
            />
            <span className="min-w-0">
              <span className="block font-display text-[13px] font-extrabold text-red">
                {c.packs.useCredit}
              </span>
              <span className="block truncate text-[11px] text-ink/55">{credit.label}</span>
            </span>
          </span>
          <span
            className={`shrink-0 font-display text-sm font-extrabold ${
              credit.applied ? "text-red" : "text-ink/35"
            }`}
          >
            −{credit.amount}
          </span>
        </label>
      )}
      {!credit && creditNote && (
        <p className="mt-4 text-start text-[12px] text-ink/50">{creditNote}</p>
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
