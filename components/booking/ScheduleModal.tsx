"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Modal from "./Modal";
import { useI18n } from "@/lib/i18n";
import { formatDateLabel, monthLabel, subtractPartyHolds } from "@/lib/booking";
import type { PartyHold } from "@/lib/booking";

// Date + time picker (Figma 235:758), now backed by the availability engine
// instead of a hardcoded June-2026 grid: days with no free chair are disabled,
// and the time grid comes from /api/availability for the chosen day and the
// duration of what's actually being booked.

type Slot = {
  time: string;
  startsAt: string;
  available: boolean;
  /** Why not, from the availability engine. See SlotBlocker in lib/availability. */
  blockedBy: "closed" | "past" | "full" | "too-soon" | null;
  /** Chairs free for the whole duration. What `partyHolds` is subtracted from. */
  freeCount: number;
};

/** Shared empty default — a fresh `[]` per render would invalidate the memo. */
const NO_HOLDS: PartyHold[] = [];

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export default function ScheduleModal({
  branchId,
  durationMin,
  partyHolds = NO_HOLDS,
  initialDate,
  initialTime,
  lastDate = null,
  onlyDate = null,
  onConfirm,
  onClose,
}: {
  branchId: string;
  durationMin: number;
  /**
   * Hours the rest of the party has already taken at *this* branch.
   *
   * A group books one bill but not one row: each guest picks her own branch and
   * her own hour, and none of it is written down until somebody pays. So the
   * server answering this guest's question has no idea she is standing next to
   * three friends — it says the last chair is free, because it is, and says the
   * same to all four. They all pick it, and createBookings refuses the party.
   *
   * The screen is the only place that knows the party exists, so the screen is
   * where the subtraction has to happen: a slot her friends already fill is
   * struck through for her, before she can choose it.
   *
   * Only overlapping holds count. Non-overlapping ones do not touch her chair,
   * and the flexibility to book 11:00 while a friend takes 14:00 is the whole
   * point of the group page — a blunter rule that counted every friend on the
   * day would hide hours that are genuinely bookable.
   */
  partyHolds?: PartyHold[];
  initialDate: string | null;
  initialTime: string | null;
  /**
   * Latest bookable day, `YYYY-MM-DD`, inclusive. Set for a refill, whose
   * appointment has to fall inside its window — a nail refill is only a refill
   * while the nails are still on, so a date past the deadline is not a late
   * booking, it is a full-price appointment.
   *
   * The server refuses these too (`refill-window` in lib/bookings.ts); this
   * stops the customer picking one only to be turned away at payment.
   */
  lastDate?: string | null;
  /**
   * Fix the day and pick only a time on it, `YYYY-MM-DD`.
   *
   * Set for every guest in a group after the first: a party books one day, so
   * the second guest is not choosing a date, she is choosing an hour on a date
   * already chosen. The calendar is hidden rather than shown-with-one-day-
   * enabled, because a month grid where thirty dates refuse the click is a
   * puzzle, not a picker.
   */
  onlyDate?: string | null;
  /** Returns the local date, the wall-clock time, and the exact UTC instant. */
  onConfirm: (date: string, time: string, startsAt: string) => void;
  onClose: () => void;
}) {
  const { c, lang } = useI18n();

  const today = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState(() => {
    const base = initialDate ? new Date(`${initialDate}T12:00:00Z`) : today;
    return { year: base.getUTCFullYear(), month0: base.getUTCMonth() };
  });

  const [date, setDate] = useState<string | null>(onlyDate ?? initialDate);
  const [time, setTime] = useState<string | null>(initialTime);
  const [days, setDays] = useState<Record<string, boolean> | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  /** The salon's booking notice, from the server. 0 for staff, who are exempt. */
  const [leadTimeMin, setLeadTimeMin] = useState(0);

  /**
   * The server's answer, minus the friends it could not see. See partyHolds.
   *
   * `freeCount` rather than a second request with `guests=n`: how many chairs
   * this guest needs is a different number at every hour of the day, depending
   * on which of her friends overlap it, and one query cannot carry four answers.
   */
  const shown = useMemo(
    () => (slots ? subtractPartyHolds(slots, durationMin, partyHolds) : slots),
    [slots, partyHolds, durationMin],
  );

  /**
   * The one line that explains a greyed-out morning.
   *
   * Three cases, and the third is the one that used to send people away:
   *
   * - nothing on this day is bookable and none of it is a notice problem —
   *   the day is simply gone or full, and `noSlots`/the struck-through grid
   *   already says so;
   * - some slots are only too soon — name the rule and the earliest time, so
   *   "why can't I book 17:00" has a visible answer;
   * - *every* remaining slot today is too soon — say the day is finished rather
   *   than leaving a grid of amber buttons that all refuse.
   *
   * Derived from the slots themselves, so it can never disagree with them: the
   * earliest is the first bookable slot the server actually returned.
   */
  const notice = useMemo(() => {
    if (!shown?.length) return null;

    // Nothing bookable at all, for any reason — the day is closed, gone, or
    // full. Checked before the notice rule so a grid that is entirely struck
    // through always says *something*: at 20:00 every slot is simply past, and
    // twenty-seven crossed-out buttons with no sentence is how the picker looked
    // before, whatever the reason underneath.
    const firstOpen = shown.find((s) => s.available);
    if (!firstOpen) return c.modals.noneLeftToday;

    // Past this point some slot is bookable, so the only line worth adding is
    // the one that explains the ones above it.
    if (!shown.some((s) => s.blockedBy === "too-soon")) return null;

    // The salon's rule as the server applied it. Deriving it from the grid
    // instead would be wrong whenever the slot length and the notice do not
    // divide evenly — a 30-minute notice on hourly slots reads as an hour.
    if (leadTimeMin <= 0) return null;

    const label =
      leadTimeMin < 60
        ? c.modals.noticeMinutes(leadTimeMin)
        : leadTimeMin % 60 === 0 && leadTimeMin / 60 === 1
          ? c.modals.noticeHour
          : leadTimeMin % 60 === 0
            ? c.modals.noticeHours(leadTimeMin / 60)
            : c.modals.noticeMinutes(leadTimeMin);

    return c.modals.noticeHint(label, firstOpen.time);
  }, [shown, leadTimeMin, c.modals]);

  const monthKey = `${cursor.year}-${pad(cursor.month0 + 1)}`;

  // Which days in the visible month have any free slot.
  //
  // Not adjusted for partyHolds: that subtraction is per hour, and a day is
  // bookable if *any* hour is. A day her friends have entirely filled still
  // opens, and the grid below then strikes every hour through and says so —
  // which is the honest answer, arrived at one click later.
  useEffect(() => {
    let cancelled = false;
    setDays(null);
    fetch(
      `/api/availability?branchId=${branchId}&month=${monthKey}&duration=${durationMin}`,
    )
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setDays(d.days ?? {});
      })
      .catch(() => {
        if (!cancelled) setDays({});
      });
    return () => {
      cancelled = true;
    };
  }, [branchId, monthKey, durationMin]);

  // Slots for the selected day.
  useEffect(() => {
    if (!date) return setSlots(null);
    let cancelled = false;
    setSlots(null);
    fetch(
      `/api/availability?branchId=${branchId}&date=${date}&duration=${durationMin}`,
    )
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setSlots(d.slots ?? []);
        setLeadTimeMin(typeof d.leadTimeMin === "number" ? d.leadTimeMin : 0);
      })
      .catch(() => {
        if (!cancelled) setSlots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [branchId, date, durationMin]);

  const daysInMonth = new Date(Date.UTC(cursor.year, cursor.month0 + 1, 0)).getUTCDate();
  // Saturday-first, matching the dictionary's weekday arrays.
  const leadBlanks = (new Date(Date.UTC(cursor.year, cursor.month0, 1)).getUTCDay() + 1) % 7;

  const step = (delta: number) =>
    setCursor(({ year, month0 }) => {
      const next = month0 + delta;
      return { year: year + Math.floor(next / 12), month0: ((next % 12) + 12) % 12 };
    });

  const selectedSlot = shown?.find((s) => s.time === time) ?? null;

  return (
    <Modal title={c.modals.scheduleTitle} onClose={onClose} className="max-w-[720px]">
      {onlyDate ? (
        <p className="mb-5 rounded-[14px] bg-cream/70 p-4 text-center text-sm font-semibold text-ink">
          {formatDateLabel(onlyDate, lang)}
        </p>
      ) : (
        <>
      <div className="mb-4 flex items-center justify-between">
        <button
          type="button"
          onClick={() => step(-1)}
          className="grid h-9 w-9 place-items-center rounded-full text-ink/50 transition-colors hover:bg-black/[0.05] hover:text-ink"
          aria-label="previous month"
        >
          <ChevronLeft className="h-4 w-4 rtl:rotate-180" strokeWidth={2} />
        </button>
        <p className="font-display text-lg font-extrabold text-ink">
          {monthLabel(cursor.year, cursor.month0, lang)}
        </p>
        <button
          type="button"
          onClick={() => step(1)}
          className="grid h-9 w-9 place-items-center rounded-full text-ink/50 transition-colors hover:bg-black/[0.05] hover:text-ink"
          aria-label="next month"
        >
          <ChevronRight className="h-4 w-4 rtl:rotate-180" strokeWidth={2} />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-y-2 text-center">
        {c.date.weekdaysShort.map((w) => (
          <span key={w} className="pb-2 text-[13px] text-ink/40">
            {w}
          </span>
        ))}
        {Array.from({ length: leadBlanks }, (_, i) => <span key={`b${i}`} />)}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const dayNum = i + 1;
          const key = `${monthKey}-${pad(dayNum)}`;
          // Until the month loads, days render enabled-but-quiet rather than
          // flashing every date to disabled and back.
          const loading = days === null;
          // String compare is safe and cheap on YYYY-MM-DD, and avoids dragging
          // timezones into a question that is purely about calendar days.
          const pastWindow = lastDate !== null && key > lastDate;
          const disabled = pastWindow || (!loading && !days[key]);
          const selected = key === date;

          return (
            <div key={key} className="grid place-items-center py-0.5">
              <button
                type="button"
                disabled={disabled || loading}
                onClick={() => {
                  setDate(key);
                  setTime(null);
                }}
                className={`grid h-10 w-10 place-items-center rounded-full text-[15px] transition-colors ${
                  selected
                    ? "bg-red font-bold text-white shadow-[0_6px_16px_rgba(184,0,7,0.35)]"
                    : disabled
                      ? "cursor-not-allowed text-ink/20"
                      : loading
                        ? "text-ink/30"
                        : "text-ink hover:bg-red/10"
                }`}
              >
                {dayNum}
              </button>
            </div>
          );
        })}
      </div>
        </>
      )}

      {onlyDate ? null : <hr className="my-6 border-black/[0.07]" />}

      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13px] text-ink/45">
          {date ? formatDateLabel(date, lang) : c.modals.pickDayFirst}
        </span>
        <h4 className="font-display text-lg font-extrabold text-ink">{c.modals.chooseTime}</h4>
      </div>

      {!date ? null : shown === null ? (
        <p className="py-6 text-center text-sm text-ink/40">…</p>
      ) : shown.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink/45">{c.modals.noSlots}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {shown.map((s) => {
              const selected = s.time === time;
              // "Too soon" is not "gone": the chair is free and the only problem
              // is how much notice is left. Struck through it reads as booked and
              // the customer stops looking, so it keeps its digits and says why.
              const tooSoon = s.blockedBy === "too-soon";
              return (
                <button
                  key={s.time}
                  type="button"
                  dir="ltr"
                  disabled={!s.available}
                  onClick={() => setTime(s.time)}
                  title={
                    tooSoon
                      ? c.modals.slotTooSoon
                      : s.blockedBy === "full"
                        ? c.modals.slotFull
                        : s.blockedBy === "past"
                          ? c.modals.slotPast
                          : undefined
                  }
                  className={`rounded-[14px] py-3.5 text-center text-sm transition-colors ${
                    selected
                      ? "bg-red font-bold text-white shadow-[0_6px_16px_rgba(184,0,7,0.25)]"
                      : s.available
                        ? "bg-[#f7f7f7] text-ink hover:bg-red/10"
                        : tooSoon
                          ? "cursor-not-allowed border border-dashed border-[#b7791f]/45 bg-[#fdf6e7] text-[#8a5a06]/70"
                          : "cursor-not-allowed bg-[#f7f7f7] text-ink/25 line-through"
                  }`}
                >
                  {s.time}
                </button>
              );
            })}
          </div>

          {/* One line under the grid rather than a note per button: the rule is
              the same for every slot it touches, and repeating it four times is
              how a picker starts shouting. */}
          {notice ? (
            <p className="mt-4 text-center text-[13px] text-[#8a5a06]">{notice}</p>
          ) : null}
        </>
      )}

      <button
        type="button"
        disabled={!date || !selectedSlot}
        onClick={() => date && selectedSlot && onConfirm(date, selectedSlot.time, selectedSlot.startsAt)}
        className={`mt-8 block w-full rounded-[12px] py-3.5 text-center text-sm font-bold transition-colors ${
          date && selectedSlot
            ? "bg-red-grad text-white hover:opacity-90"
            : "cursor-not-allowed bg-black/[0.06] text-ink/40"
        }`}
      >
        {c.modals.confirmSchedule}
      </button>
    </Modal>
  );
}
