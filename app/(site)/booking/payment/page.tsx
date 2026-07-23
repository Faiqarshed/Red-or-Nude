"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import PaymentMethods from "@/components/PaymentMethods";
import { Riyal, Lock } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { clearBooking, emptySelection, loadBooking, type BookingSelection } from "@/lib/booking";

// Figma: Desktop-2 payment step (276:1902 / 276:6624) + success modal (276:6765).
//
// Confirming here is what creates the real booking: POST /api/bookings writes
// the appointment, reserves a chair and returns a reference code. Payment itself
// is still a stub — a gateway (Moyasar/Tap) lands in a later phase.

export default function PaymentPage() {
  const { c, lang } = useI18n();
  const p = c.payment;
  const router = useRouter();

  const [booking, setBooking] = useState<BookingSelection>(emptySelection);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [method, setMethod] = useState(p.cardTitle);

  useEffect(() => {
    const saved = loadBooking();
    if (saved) setBooking(saved);
    setLoaded(true);
  }, []);

  // A direct visit with nothing selected has nothing to pay for.
  const hasSelection = booking.serviceId !== null && booking.startsAt !== null;

  const summary = [
    { label: p.rowService, value: booking.service ?? "—" },
    { label: c.booking.addons, value: booking.addons.length ? booking.addons.join("، ") : c.booking.none },
    { label: c.booking.removal, value: booking.removal ?? c.booking.none },
    {
      label: c.booking.appointment,
      value:
        booking.dateLabel && booking.timeLabel
          ? `${booking.dateLabel} - ${booking.timeLabel}`
          : c.booking.notSelected,
    },
  ];

  const confirm = async () => {
    if (!hasSelection || submitting) return;
    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId: booking.branchId,
          serviceId: booking.serviceId,
          addonIds: booking.addonIds,
          removalTypeId: booking.removalTypeId,
          designId: booking.designId,
          startsAt: booking.startsAt,
          customer: { name: name.trim() || undefined, phone: phone.trim(), lang },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setCode(data.code);
        clearBooking();
        return;
      }

      const data = await res.json().catch(() => ({}));
      // 409 means someone else took the chair while this customer was typing —
      // send them back to pick another time rather than showing a dead end.
      if (res.status === 409) setError(p.slotTaken);
      else if (data.error === "invalid" && data.issues?.includes("customer.phone")) {
        setError(p.invalidPhone);
      } else setError(p.bookingFailed);
    } catch {
      setError(p.bookingFailed);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="relative min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto grid max-w-page gap-8 px-6 pb-24 pt-[120px] md:px-12 lg:grid-cols-[1fr_540px] lg:px-16">
        <PaymentMethods onConfirm={confirm} onMethodChange={setMethod} />

        {/* Summary */}
        <aside className="h-fit rounded-[24px] bg-white p-6 text-start shadow-[0_20px_50px_rgba(184,0,7,0.06)]">
          <h2 className="mb-5 text-center font-display text-2xl font-extrabold text-ink">
            {p.summaryTitle}
          </h2>

          {loaded && !hasSelection ? (
            <div className="rounded-[14px] bg-[#fbeaea] p-5 text-center">
              <p className="text-sm text-ink/70">{p.noSelection}</p>
              <Link
                href="/booking"
                className="mt-3 inline-block rounded-[12px] bg-red-grad px-5 py-2.5 text-sm font-bold text-white"
              >
                {p.newBooking}
              </Link>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                {summary.map((r) => (
                  <div key={r.label} className="rounded-[14px] border border-black/[0.05] p-4">
                    <p className="mb-1 text-[11px] text-ink/45">{r.label}</p>
                    <p className="text-sm font-semibold text-ink">{r.value}</p>
                  </div>
                ))}
              </div>

              {/* A booking needs someone to belong to — the static flow never
                  asked who was booking. */}
              <div className="mt-4 space-y-3">
                <label className="block text-start">
                  <span className="mb-1.5 block text-[12px] text-ink/55">{p.customerName}</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full rounded-[12px] border border-black/[0.08] px-4 py-3 text-sm text-ink outline-none focus:border-red/40"
                  />
                </label>
                <label className="block text-start">
                  <span className="mb-1.5 block text-[12px] text-ink/55">{p.customerPhone} *</span>
                  <input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    dir="ltr"
                    inputMode="tel"
                    placeholder="05XXXXXXXX"
                    className="w-full rounded-[12px] border border-black/[0.08] px-4 py-3 text-left text-sm text-ink outline-none placeholder:text-ink/30 focus:border-red/40"
                  />
                </label>
              </div>

              <div className="mt-4 flex items-center justify-between rounded-[14px] bg-[#fbeaea] p-4">
                <div className="flex items-center gap-1 font-display text-2xl font-extrabold text-red">
                  <Riyal className="h-5 w-5" />
                  {booking.total}
                </div>
                <p className="text-xs text-ink/45">{p.total}</p>
              </div>

              {error && (
                <p role="alert" className="mt-3 rounded-[12px] bg-red/[0.08] px-4 py-3 text-start text-xs text-red">
                  {error}
                </p>
              )}

              <button
                type="button"
                onClick={confirm}
                disabled={submitting || !phone.trim()}
                className={`mt-6 block w-full rounded-[12px] py-3.5 text-center text-sm font-bold transition-opacity ${
                  submitting || !phone.trim()
                    ? "cursor-not-allowed bg-black/[0.06] text-ink/40"
                    : "bg-red-grad text-white hover:opacity-90"
                }`}
              >
                {submitting ? p.confirming : p.confirmPay}
              </button>
              <p className="mt-3 flex items-center justify-center gap-1.5 text-[12px] text-ink/45">
                <Lock className="h-3.5 w-3.5" />
                {p.secure}
              </p>
            </>
          )}
        </aside>
      </div>

      <SiteFooter />

      {code && (
        <SuccessModal
          booking={booking}
          code={code}
          method={method}
          onClose={() => router.push("/")}
        />
      )}
    </main>
  );
}

function SuccessModal({
  booking,
  code,
  method,
  onClose,
}: {
  booking: BookingSelection;
  code: string;
  method: string;
  onClose: () => void;
}) {
  const { c } = useI18n();
  const p = c.payment;
  const rows = [
    { label: p.rowService, value: booking.service ?? "—" },
    { label: p.rowAddons, value: booking.addons.length ? booking.addons.join("، ") : c.booking.none },
    { label: p.rowRemoval, value: booking.removal ?? c.booking.none },
    { label: p.rowDate, value: booking.dateLabel ?? "—" },
    { label: p.rowTime, value: booking.timeLabel ?? "—" },
    { label: p.rowMethod, value: method },
  ];

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/30 px-4 py-10 backdrop-blur-sm">
      <div className="w-full max-w-[460px] rounded-[24px] bg-white p-8 text-center shadow-[0_40px_100px_rgba(0,0,0,0.25)]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/pay/success-check.webp" alt="" className="mx-auto mb-5 h-20 w-20" />
        <h3 className="font-display text-2xl font-extrabold text-ink">{p.successTitle}</h3>
        <p className="mx-auto mt-2 max-w-[320px] text-sm text-ink/55">{p.successSub}</p>

        {/* The reference the salon will ask for on the phone. */}
        <p className="mt-4 inline-block rounded-full bg-[#f6f6f6] px-5 py-2 font-display text-lg font-extrabold tracking-wider text-red" dir="ltr">
          {code}
        </p>

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
