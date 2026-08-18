"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Modal from "./Modal";
import { useI18n } from "@/lib/i18n";
import { formatDateLabel, monthLabel } from "@/lib/booking";

// Date + time picker (Figma 235:758), now backed by the availability engine
// instead of a hardcoded June-2026 grid: days with no free chair are disabled,
// and the time grid comes from /api/availability for the chosen day and the
// duration of what's actually being booked.

type Slot = { time: string; startsAt: string; available: boolean };

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export default function ScheduleModal({
  branchId,
  durationMin,
  guests = 1,
  initialDate,
  initialTime,
  lastDate = null,
  onConfirm,
  onClose,
}: {
  branchId: string;
  durationMin: number;
  /** How many chairs must be free at once — 2 when booking for a pair. */
  guests?: number;
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

  const [date, setDate] = useState<string | null>(initialDate);
  const [time, setTime] = useState<string | null>(initialTime);
  const [days, setDays] = useState<Record<string, boolean> | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);

  const monthKey = `${cursor.year}-${pad(cursor.month0 + 1)}`;

  // Which days in the visible month have any free slot.
  useEffect(() => {
    let cancelled = false;
    setDays(null);
    fetch(
      `/api/availability?branchId=${branchId}&month=${monthKey}&duration=${durationMin}&guests=${guests}`,
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
  }, [branchId, monthKey, durationMin, guests]);

  // Slots for the selected day.
  useEffect(() => {
    if (!date) return setSlots(null);
    let cancelled = false;
    setSlots(null);
    fetch(
      `/api/availability?branchId=${branchId}&date=${date}&duration=${durationMin}&guests=${guests}`,
    )
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setSlots(d.slots ?? []);
      })
      .catch(() => {
        if (!cancelled) setSlots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [branchId, date, durationMin, guests]);

  const daysInMonth = new Date(Date.UTC(cursor.year, cursor.month0 + 1, 0)).getUTCDate();
  // Saturday-first, matching the dictionary's weekday arrays.
  const leadBlanks = (new Date(Date.UTC(cursor.year, cursor.month0, 1)).getUTCDay() + 1) % 7;

  const step = (delta: number) =>
    setCursor(({ year, month0 }) => {
      const next = month0 + delta;
      return { year: year + Math.floor(next / 12), month0: ((next % 12) + 12) % 12 };
    });

  const selectedSlot = slots?.find((s) => s.time === time) ?? null;

  return (
    <Modal title={c.modals.scheduleTitle} onClose={onClose} className="max-w-[720px]">
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

      <hr className="my-6 border-black/[0.07]" />

      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13px] text-ink/45">
          {date ? formatDateLabel(date, lang) : c.modals.pickDayFirst}
        </span>
        <h4 className="font-display text-lg font-extrabold text-ink">{c.modals.chooseTime}</h4>
      </div>

      {!date ? null : slots === null ? (
        <p className="py-6 text-center text-sm text-ink/40">…</p>
      ) : slots.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink/45">{c.modals.noSlots}</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {slots.map((s) => {
            const selected = s.time === time;
            return (
              <button
                key={s.time}
                type="button"
                dir="ltr"
                disabled={!s.available}
                onClick={() => setTime(s.time)}
                className={`rounded-[14px] py-3.5 text-center text-sm transition-colors ${
                  selected
                    ? "bg-red font-bold text-white shadow-[0_6px_16px_rgba(184,0,7,0.25)]"
                    : s.available
                      ? "bg-[#f7f7f7] text-ink hover:bg-red/10"
                      : "cursor-not-allowed bg-[#f7f7f7] text-ink/25 line-through"
                }`}
              >
                {s.time}
              </button>
            );
          })}
        </div>
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
