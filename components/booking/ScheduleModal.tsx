"use client";

import { useState } from "react";
import Modal from "./Modal";
import { useI18n } from "@/lib/i18n";
import {
  CAL_LEAD_BLANKS,
  CAL_DAYS_IN_MONTH,
  CAL_FIRST_BOOKABLE,
  TIME_SLOTS,
  formatDateFull,
} from "@/lib/booking";

// Date + time picker (Figma 235:758): June 2026 calendar (Saturday-first) over
// a grid of 30-min time slots.
export default function ScheduleModal({
  initialDay,
  initialTime,
  onConfirm,
  onClose,
}: {
  initialDay: number | null;
  initialTime: string | null;
  onConfirm: (day: number, time: string) => void;
  onClose: () => void;
}) {
  const { c } = useI18n();
  const [day, setDay] = useState<number | null>(initialDay);
  const [time, setTime] = useState<string | null>(initialTime);

  const days = [
    ...Array.from({ length: CAL_LEAD_BLANKS }, () => null),
    ...Array.from({ length: CAL_DAYS_IN_MONTH }, (_, i) => i + 1),
  ];

  return (
    <Modal title={c.modals.scheduleTitle} onClose={onClose} className="max-w-[720px]">
      {/* Calendar */}
      <p className="mb-4 font-display text-lg font-extrabold text-ink">{c.date.monthLabel}</p>
      <div className="grid grid-cols-7 gap-y-2 text-center">
        {c.date.weekdaysShort.map((w) => (
          <span key={w} className="pb-2 text-[13px] text-ink/40">
            {w}
          </span>
        ))}
        {days.map((d, i) => {
          if (d === null) return <span key={`b${i}`} />;
          const disabled = d < CAL_FIRST_BOOKABLE;
          const selected = d === day;
          return (
            <div key={d} className="grid place-items-center py-0.5">
              <button
                type="button"
                disabled={disabled}
                onClick={() => setDay(d)}
                className={`grid h-10 w-10 place-items-center rounded-full text-[15px] transition-colors ${
                  selected
                    ? "bg-red font-bold text-white shadow-[0_6px_16px_rgba(184,0,7,0.35)]"
                    : disabled
                      ? "cursor-not-allowed text-ink/25"
                      : "text-ink hover:bg-red/10"
                }`}
              >
                {d}
              </button>
            </div>
          );
        })}
      </div>

      <hr className="my-6 border-black/[0.07]" />

      {/* Time */}
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13px] text-ink/45">
          {day !== null ? formatDateFull(day, c.date) : c.modals.pickDayFirst}
        </span>
        <h4 className="font-display text-lg font-extrabold text-ink">{c.modals.chooseTime}</h4>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {TIME_SLOTS.map((t) => {
          const selected = t === time;
          return (
            <button
              key={t}
              type="button"
              dir="ltr"
              onClick={() => setTime(t)}
              className={`rounded-[14px] py-3.5 text-center text-sm transition-colors ${
                selected
                  ? "bg-red font-bold text-white shadow-[0_6px_16px_rgba(184,0,7,0.25)]"
                  : "bg-[#f7f7f7] text-ink hover:bg-red/10"
              }`}
            >
              {t}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        disabled={day === null || time === null}
        onClick={() => day !== null && time !== null && onConfirm(day, time)}
        className={`mt-8 block w-full rounded-[12px] py-3.5 text-center text-sm font-bold transition-colors ${
          day !== null && time !== null
            ? "bg-red-grad text-white hover:opacity-90"
            : "cursor-not-allowed bg-black/[0.06] text-ink/40"
        }`}
      >
        {c.modals.confirmSchedule}
      </button>
    </Modal>
  );
}
