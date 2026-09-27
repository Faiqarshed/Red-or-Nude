"use client";

// The booking's success popup, shown by /booking once the payment page hands the
// tickets back (lib/paid-handoff.ts). Over the booking page rather than the spent
// checkout: that is where "New booking" starts anyway, so it just closes.

import { useEffect } from "react";
import Link from "next/link";
import { Riyal } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { formatDateLabel, formatTime } from "@/lib/booking";
import { localTime, riyadhDateKey } from "@/lib/time";

export type Ticket = {
  code: string;
  ticketNo: string;
  stationLabel: string | null;
  /** Null for a booking further out than today — nobody is assigned yet. */
  technicianName: string | null;
  serviceName: { ar: string; en: string } | null;
  startsAt: string;
  totalHalalas: number;
};

export default function BookingSuccessModal({ tickets, onClose }: { tickets: Ticket[]; onClose: () => void }) {
  const { c, lang } = useI18n();
  const p = c.payment;
  // From the tickets, not the saved selection: a checkout resumed in another tab
  // or reached back from the bank has no selection, and the tickets are what was
  // booked. The party's first start, as the selection showed it.
  const first = new Date(Math.min(...tickets.map((t) => Date.parse(t.startsAt))));
  const dateLabel = Number.isNaN(first.getTime()) ? "—" : formatDateLabel(riyadhDateKey(first), lang);
  const timeLabel = Number.isNaN(first.getTime()) ? "—" : formatTime(localTime(first.toISOString()), c.date);

  // Nothing to hunt for. The booking is paid and this screen has no decision
  // left on it, so anywhere outside the card closes it, and so does Escape —
  // onto the booking page, not the checkout she has just finished.
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
        <h3 className="font-display text-2xl font-extrabold text-ink">{p.successTitle}</h3>
        <p className="mx-auto mt-2 max-w-[320px] text-sm text-ink/55">{p.successSub}</p>

        {/* The number the salon calls out, and the chair it belongs to. One block
            per guest — a pair gets consecutive numbers on different chairs. */}
        <div className="mt-6 space-y-3">
          {tickets.map((t) => (
            <div key={t.code} className="rounded-[18px] bg-[#fbeaea] p-5">
              <p className="text-[11px] uppercase tracking-wider text-red/60">{p.ticketLabel}</p>
              <p className="font-display text-4xl font-extrabold tracking-wider text-red" dir="ltr">
                {t.ticketNo}
              </p>
              <div className="mt-3 flex items-center justify-center gap-4 text-[13px]">
                <span className="text-ink/55">
                  {p.stationLabel}{" "}
                  <span className="font-bold text-ink" dir="ltr">
                    {t.stationLabel ?? "—"}
                  </span>
                </span>
                {t.serviceName && (
                  <span className="font-semibold text-ink">{t.serviceName[lang]}</span>
                )}
                {/* Only when there is one. A booking further out has no
                    technician yet — the morning run assigns on the day — and
                    an empty label would read as one nobody turned up for. */}
                {t.technicianName && (
                  <span className="text-ink/55">
                    {p.technicianLabel}{" "}
                    <span className="font-bold text-ink">{t.technicianName}</span>
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 rounded-[16px] bg-[#f6f6f6] p-5 text-start">
          <p className="mb-3 font-display text-base font-extrabold text-red">{p.detailsTitle}</p>
          <div className="divide-y divide-black/[0.06]">
            {[
              { label: p.rowDate, value: dateLabel },
              { label: p.rowTime, value: timeLabel },
            ].map((r) => (
              <div key={r.label} className="flex items-center justify-between py-2.5">
                <span className="text-[13px] text-ink/50">{r.label}</span>
                <span className="text-[13px] font-semibold text-ink">{r.value}</span>
              </div>
            ))}
            <div className="flex items-center justify-between py-2.5">
              <span className="text-[13px] text-ink/50">{p.rowTotal}</span>
              <span className="flex items-center gap-1 font-display text-base font-extrabold text-red">
                <Riyal className="h-4 w-4" />
                {/* Summed from the tickets, not from the selection: this is what
                    the card was actually charged, discounts and all. */}
                {tickets.reduce((sum, t) => sum + t.totalHalalas, 0) / 100}
              </span>
            </div>
          </div>
        </div>

        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-[12px] bg-black/[0.05] py-3.5 text-center text-sm font-bold text-ink transition-colors hover:bg-black/[0.08]"
          >
            {p.newBooking}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-[12px] bg-red-grad py-3.5 text-center text-sm font-bold text-white transition-opacity hover:opacity-90"
          >
            {p.close}
          </button>
        </div>

        {/* The reference goes out by email only — nothing here to memorise. */}
        <Link
          href="/my-bookings"
          className="mt-4 inline-block text-[12px] font-semibold text-red underline underline-offset-4"
        >
          {p.myBookings}
        </Link>
      </div>
    </div>
  );
}
