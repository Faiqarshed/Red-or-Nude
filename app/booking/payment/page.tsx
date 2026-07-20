"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import PaymentMethods from "@/components/PaymentMethods";
import { Riyal, Lock } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import {
  loadBooking,
  formatDate,
  formatTime,
  weekdayFull,
  type BookingSelection,
} from "@/lib/booking";

// Figma: Desktop-2 payment step (276:1902 / 276:6624) + success modal (276:6765).
// Renders the real selection made on /booking; falls back to sample values on a
// direct visit.
const FALLBACK: BookingSelection = {
  service: "Gel Polish",
  addons: ["Nail Art"],
  removal: "gel",
  design: null,
  day: 16,
  time: "22:30",
  total: 220,
};

export default function PaymentPage() {
  const { c } = useI18n();
  const p = c.payment;
  const [booking, setBooking] = useState<BookingSelection>(FALLBACK);
  const [done, setDone] = useState(false);
  const [method, setMethod] = useState(p.cardTitle);

  useEffect(() => {
    const saved = loadBooking();
    if (saved) setBooking(saved);
  }, []);

  const removalName = booking.removal
    ? c.removals.find((r) => r.id === booking.removal)?.name ?? c.booking.none
    : c.booking.none;

  const appointment =
    booking.day !== null && booking.time !== null
      ? `${formatDate(booking.day, c.date)} - ${weekdayFull(booking.day, c.date)} - ${formatTime(booking.time, c.date)}`
      : c.booking.notSelected;

  const summary = [
    { label: p.rowService, value: booking.service ?? "—" },
    { label: c.booking.addons, value: booking.addons.length ? booking.addons.join("، ") : c.booking.none },
    { label: c.booking.removal, value: removalName },
    { label: c.booking.appointment, value: appointment },
  ];

  return (
    <main className="relative min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto grid max-w-page gap-8 px-6 pb-24 pt-[120px] md:px-12 lg:grid-cols-[1fr_540px] lg:px-16">
        <PaymentMethods onConfirm={() => setDone(true)} onMethodChange={setMethod} />

        {/* Summary */}
        <aside className="h-fit rounded-[24px] bg-white p-6 text-start shadow-[0_20px_50px_rgba(184,0,7,0.06)]">
          <h2 className="mb-5 text-center font-display text-2xl font-extrabold text-ink">
            {p.summaryTitle}
          </h2>
          <div className="grid grid-cols-2 gap-3">
            {summary.map((r) => (
              <div key={r.label} className="rounded-[14px] border border-black/[0.05] p-4">
                <p className="mb-1 text-[11px] text-ink/45">{r.label}</p>
                <p className="text-sm font-semibold text-ink">{r.value}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-center justify-between rounded-[14px] bg-[#fbeaea] p-4">
            <div className="flex items-center gap-1 font-display text-2xl font-extrabold text-red">
              <Riyal className="h-5 w-5" />
              {booking.total}
            </div>
            <p className="text-xs text-ink/45">{p.total}</p>
          </div>

          <button
            type="button"
            onClick={() => setDone(true)}
            className="mt-6 block w-full rounded-[12px] bg-red-grad py-3.5 text-center text-sm font-bold text-white transition-opacity hover:opacity-90"
          >
            {p.confirmPay}
          </button>
          <p className="mt-3 flex items-center justify-center gap-1.5 text-[12px] text-ink/45">
            <Lock className="h-3.5 w-3.5" />
            {p.secure}
          </p>
        </aside>
      </div>

      <SiteFooter />

      {done && (
        <SuccessModal
          booking={booking}
          removalName={removalName}
          method={method}
          onClose={() => setDone(false)}
        />
      )}
    </main>
  );
}

function SuccessModal({
  booking,
  removalName,
  method,
  onClose,
}: {
  booking: BookingSelection;
  removalName: string;
  method: string;
  onClose: () => void;
}) {
  const { c } = useI18n();
  const p = c.payment;
  const rows = [
    { label: p.rowService, value: booking.service ?? "—" },
    { label: p.rowAddons, value: booking.addons.length ? booking.addons.join("، ") : c.booking.none },
    { label: p.rowRemoval, value: removalName },
    { label: p.rowDate, value: booking.day !== null ? formatDate(booking.day, c.date) : "—" },
    { label: p.rowTime, value: booking.time !== null ? formatTime(booking.time, c.date) : "—" },
    { label: p.rowMethod, value: method },
  ];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/30 px-4 py-10 backdrop-blur-sm">
      <div className="w-full max-w-[460px] rounded-[24px] bg-white p-8 text-center shadow-[0_40px_100px_rgba(0,0,0,0.25)]">
        <img src="/pay/success-check.webp" alt="" className="mx-auto mb-5 h-20 w-20" />
        <h3 className="font-display text-2xl font-extrabold text-ink">{p.successTitle}</h3>
        <p className="mx-auto mt-2 max-w-[320px] text-sm text-ink/55">{p.successSub}</p>

        <div className="mt-6 rounded-[16px] bg-[#f6f6f6] p-5 text-start">
          <p className="mb-3 font-display text-base font-extrabold text-red">{p.detailsTitle}</p>
          <div className="divide-y divide-black/[0.06]">
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between py-2.5">
                <span className="text-[13px] text-ink/50">{r.label}</span>
                <span className="text-[13px] font-semibold text-ink">{r.value}</span>
              </div>
            ))}
            <div className="flex items-center justify-between py-2.5">
              <span className="text-[13px] text-ink/50">{p.rowTotal}</span>
              <span className="flex items-center gap-1 font-display text-base font-extrabold text-red">
                <Riyal className="h-4 w-4" />
                {booking.total}
              </span>
            </div>
          </div>
        </div>

        <div className="mt-6 flex gap-3">
          <Link
            href="/booking"
            className="flex-1 rounded-[12px] bg-black/[0.05] py-3.5 text-center text-sm font-bold text-ink transition-colors hover:bg-black/[0.08]"
          >
            {p.newBooking}
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-[12px] bg-red-grad py-3.5 text-center text-sm font-bold text-white transition-opacity hover:opacity-90"
          >
            {p.close}
          </button>
        </div>
      </div>
    </div>
  );
}
