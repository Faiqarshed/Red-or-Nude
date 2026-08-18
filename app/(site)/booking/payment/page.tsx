"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import PaymentMethods from "@/components/PaymentMethods";
import PhoneField from "@/components/PhoneField";
import { Riyal, Lock } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { clearBooking, emptySelection, loadBooking, type BookingSelection } from "@/lib/booking";
import { isValidSaudiMobile, toStoredPhone } from "@/lib/phone";

// Figma: Desktop-2 payment step (276:1902 / 276:6624) + success modal (276:6765).
//
// Two calls, in order:
//   POST /api/bookings         → holds the chair(s), rows written as `pending`
//   POST /api/payments/confirm → charges, confirms, and issues the ticket numbers
//
// Nothing is a booking until the second one succeeds. A declined card leaves the
// hold in place so the customer can retry without losing their slot, which is why
// the created code is kept in state between attempts.
//
// The gateway itself is still a stand-in (lib/payments/fake.ts) — no money moves
// until PAYMENT_DRIVER points at Moyasar or Tap.

type Ticket = {
  code: string;
  ticketNo: string;
  stationLabel: string | null;
  serviceName: { ar: string; en: string } | null;
  startsAt: string;
  totalHalalas: number;
};

const METHOD_KEYS = ["cardTitle", "madaTitle", "stcTitle", "appleTitle"] as const;

export default function PaymentPage() {
  const { c, lang } = useI18n();
  const p = c.payment;
  const router = useRouter();

  const [booking, setBooking] = useState<BookingSelection>(emptySelection);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [method, setMethod] = useState(p.cardTitle);
  /** Set once the hold exists, so a retry after a decline doesn't re-book. */
  const [heldCode, setHeldCode] = useState<string | null>(null);
  /** Card fields live inside PaymentMethods; this mirrors their validity up. */
  const [cardValid, setCardValid] = useState(false);
  const [phoneTouched, setPhoneTouched] = useState(false);

  useEffect(() => {
    const saved = loadBooking();
    if (saved) setBooking(saved);
    setLoaded(true);
  }, []);

  // A direct visit with nothing selected has nothing to pay for.
  const hasSelection = booking.members.length > 0 && booking.startsAt !== null;

  // The invoice is emailed the moment the charge clears, so an address is as
  // required as the phone number. Kept loose on purpose — the server's zod
  // schema is the real check, and a strict regex here only ever rejects
  // addresses that are actually valid.
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const phoneOk = isValidSaudiMobile(phone);
  const canSubmit = phoneOk && emailOk && cardValid;

  /** Which enum value the API wants for the label the customer clicked. */
  const methodCode = (): "card" | "mada" | "stc" | "apple" => {
    const i = METHOD_KEYS.findIndex((k) => p[k] === method);
    return (["card", "mada", "stc", "apple"] as const)[i === -1 ? 0 : i];
  };

  const confirm = async () => {
    if (!hasSelection || submitting) return;
    // PaymentMethods has its own confirm button, which doesn't know about these
    // fields — so the guard lives here rather than only on the disabled prop.
    if (!emailOk) {
      setError(p.invalidEmail);
      return;
    }
    setError(null);
    setSubmitting(true);

    try {
      // Step 1 — hold the chairs, unless a previous attempt already did.
      let code = heldCode;
      if (!code) {
        const res = await fetch("/api/bookings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            branchId: booking.branchId,
            startsAt: booking.startsAt,
            members: booking.members.map((m) => ({
              serviceId: m.serviceId,
              addonIds: m.addonIds,
              removalTypeId: m.removalTypeId,
              designId: m.designId,
            })),
            customer: {
              name: name.trim() || undefined,
              phone: toStoredPhone(phone),
              email: email.trim(),
              lang,
            },
            refillOfCode: booking.refillOf ?? null,
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          // 409 means the thing they were looking at is gone: either someone
          // took the chair while they typed, or the refill window just lapsed.
          if (data.error === "refill-expired") setError(p.refillExpired);
          else if (res.status === 409) setError(p.slotTaken);
          else if (data.error === "invalid" && data.issues?.includes("customer.phone")) {
            setError(p.invalidPhone);
          } else if (data.error === "invalid" && data.issues?.includes("customer.email")) {
            setError(p.invalidEmail);
          } else setError(p.bookingFailed);
          return;
        }

        code = (await res.json()).bookings[0].code as string;
        setHeldCode(code);
      }

      // Step 2 — take the money. Only this confirms anything.
      const pay = await fetch("/api/payments/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, method: methodCode() }),
      });

      if (pay.ok) {
        const data = await pay.json();
        setTickets(data.tickets);
        clearBooking();
        return;
      }

      const data = await pay.json().catch(() => ({}));
      if (data.error === "payment-declined") setError(p.declined);
      else if (data.error === "expired") {
        // The hold is gone; a retry would confirm nothing, so send them back.
        setHeldCode(null);
        setError(p.expired);
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
        <PaymentMethods
          onConfirm={confirm}
          onMethodChange={setMethod}
          onValidityChange={setCardValid}
        />

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
              <div className="space-y-4">
                {booking.members.map((m, i) => (
                  <div key={i}>
                    {booking.members.length > 1 && (
                      <p className="mb-2 font-display text-sm font-extrabold text-red">
                        {i === 0 ? c.booking.guest1 : c.booking.guest2}
                      </p>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <Field label={p.rowService} value={m.service ?? "—"} />
                      <Field
                        label={c.booking.addons}
                        value={m.addons.length ? m.addons.join("، ") : c.booking.none}
                      />
                      <Field label={c.booking.removal} value={m.removal ?? c.booking.none} />
                      <Field label={c.booking.total} value={String(m.price)} />
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-3">
                <Field
                  label={c.booking.appointment}
                  value={
                    booking.dateLabel && booking.timeLabel
                      ? `${booking.dateLabel} - ${booking.timeLabel}`
                      : c.booking.notSelected
                  }
                />
              </div>

              {/* A booking needs someone to belong to — the picker never asked. */}
              <div className="mt-4 space-y-3">
                <label className="block text-start">
                  <span className="mb-1.5 block text-[12px] text-ink/55">{p.customerName}</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={120}
                    autoComplete="name"
                    className="w-full rounded-[12px] border border-black/[0.08] px-4 py-3 text-sm text-ink outline-none focus:border-red/40"
                  />
                </label>
                <PhoneField
                  label={p.customerPhone}
                  value={phone}
                  onChange={setPhone}
                  required
                  showError={phoneTouched}
                  onBlur={() => setPhoneTouched(true)}
                />
                {/* Required twice over: it carries the booking reference that
                    is the only key to /my-bookings, and it is where the invoice
                    goes the instant the charge clears. */}
                <label className="block text-start">
                  <span className="mb-1.5 block text-[12px] text-ink/55">{p.customerEmail} *</span>
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    dir="ltr"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    maxLength={200}
                    placeholder="sarah@example.com"
                    className="w-full rounded-[12px] border border-black/[0.08] px-4 py-3 text-left text-sm text-ink outline-none placeholder:text-ink/30 focus:border-red/40"
                  />
                  <span className="mt-1.5 block text-[11px] text-ink/40">{p.emailNote}</span>
                </label>
              </div>

              {booking.total < booking.grossTotal && (
                <div className="mt-4 space-y-1.5 rounded-[14px] bg-cream/60 p-4 text-[13px]">
                  <div className="flex items-center justify-between text-ink/55">
                    <span className="flex items-center gap-1">
                      <Riyal className="h-3 w-3" />
                      {booking.grossTotal}
                    </span>
                    <span>{p.subtotal}</span>
                  </div>
                  <div className="flex items-center justify-between font-semibold text-red">
                    <span className="flex items-center gap-1">
                      −<Riyal className="h-3 w-3" />
                      {booking.grossTotal - booking.total}
                    </span>
                    <span>{p.groupDiscount}</span>
                  </div>
                </div>
              )}

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
                disabled={submitting || !canSubmit}
                className={`mt-6 block w-full rounded-[12px] py-3.5 text-center text-sm font-bold transition-opacity ${
                  submitting || !canSubmit
                    ? "cursor-not-allowed bg-black/[0.06] text-ink/40"
                    : "bg-red-grad text-white hover:opacity-90"
                }`}
              >
                {submitting ? p.confirming : p.confirmPay}
              </button>
              <p className="mt-3 text-center text-[11px] text-ink/40">{p.payFirstNote}</p>
              <p className="mt-2 flex items-center justify-center gap-1.5 text-[12px] text-ink/45">
                <Lock className="h-3.5 w-3.5" />
                {p.secure}
              </p>
            </>
          )}
        </aside>
      </div>

      <SiteFooter />

      {tickets && (
        <SuccessModal
          tickets={tickets}
          booking={booking}
          method={method}
          onClose={() => router.push("/")}
        />
      )}
    </main>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[14px] border border-black/[0.05] p-4">
      <p className="mb-1 text-[11px] text-ink/45">{label}</p>
      <p className="text-sm font-semibold text-ink">{value}</p>
    </div>
  );
}

function SuccessModal({
  tickets,
  booking,
  method,
  onClose,
}: {
  tickets: Ticket[];
  booking: BookingSelection;
  method: string;
  onClose: () => void;
}) {
  const { c, lang } = useI18n();
  const p = c.payment;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/30 px-4 py-10 backdrop-blur-sm">
      <div className="w-full max-w-[460px] rounded-[24px] bg-white p-8 text-center shadow-[0_40px_100px_rgba(0,0,0,0.25)]">
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
              </div>
              <p className="mt-2 text-[11px] text-ink/40" dir="ltr">
                {p.reference}: {t.code}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-6 rounded-[16px] bg-[#f6f6f6] p-5 text-start">
          <p className="mb-3 font-display text-base font-extrabold text-red">{p.detailsTitle}</p>
          <div className="divide-y divide-black/[0.06]">
            {[
              { label: p.rowDate, value: booking.dateLabel ?? "—" },
              { label: p.rowTime, value: booking.timeLabel ?? "—" },
              { label: p.rowMethod, value: method },
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

        {/* The reference above is the customer's only way back in, so say so
            here rather than relying on the email having arrived yet. */}
        <p className="mt-4 text-[11px] text-ink/45">{p.keepReference}</p>
        <Link
          href="/my-bookings"
          className="mt-1 inline-block text-[12px] font-semibold text-red underline underline-offset-4"
        >
          {p.myBookings}
        </Link>
      </div>
    </div>
  );
}
