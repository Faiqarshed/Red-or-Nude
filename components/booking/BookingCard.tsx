"use client";

// One appointment, with everything a customer can do to it.
//
// Lifted out of app/(site)/my-bookings/MyBookingsView.tsx when /account grew a
// second list of the same bookings. Deliberately shared rather than copied: a
// cancel button that behaves differently on two screens is how a refund policy
// quietly forks, and the cancellation window here has real money behind it.
//
// The two screens differ only in how the customer got here — a reference typed
// into a form, or a session cookie — and not in what a booking is or what may
// be done to it. So this component knows nothing about either.
//
// ponytail: the cancel / reschedule / refill routes still authenticate on the
// booking reference even for a signed-in customer, which is why the refill
// dialog below still emails a code to someone who is already signed in.
// Accepting the session as an alternative credential is tidier, but it means a
// second auth path through three routes for no behaviour the customer can see.
// Add it if that OTP step ever shows up as friction.

import Link from "next/link";
import { useState } from "react";
import ScheduleModal from "@/components/booking/ScheduleModal";
import { Riyal } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { pick } from "@/lib/localized";
import { formatDateLabel, type BookingSummary } from "@/lib/booking";


type RefillDetails = {
  daysLeft: number;
  expiresAt: string | null;
  priceSar: number;
  bookUrl: string | null;
};

const STATUS_TONE: Record<string, string> = {
  pending: "bg-black/[0.06] text-ink/60",
  confirmed: "bg-[#e8f3ec] text-[#2f7a4d]",
  checked_in: "bg-[#fdf0dc] text-[#9a6b12]",
  in_progress: "bg-[#fdf0dc] text-[#9a6b12]",
  completed: "bg-[#eef1f6] text-[#4a5a72]",
  cancelled: "bg-red/[0.08] text-red",
  no_show: "bg-red/[0.08] text-red",
};

/**
 * Turn an API refusal into something the customer can act on.
 *
 * The three reasons are kept apart on purpose: telling someone who already
 * cancelled that their window has closed sends them looking for a deadline
 * problem they do not have. See lib/cancellation.ts.
 */
function refusalMessage(
  data: { error?: string; cutoffHours?: number },
  h: { windowClosed: string; alreadyCancelled: string; notCancellable: string; failed: string },
): string {
  switch (data.error) {
    case "window-closed":
      return h.windowClosed.replace("{n}", String(data.cutoffHours ?? 3));
    case "already-cancelled":
      return h.alreadyCancelled;
    case "not-cancellable":
      return h.notCancellable;
    default:
      return h.failed;
  }
}

export default function BookingCard({
  row,
  lang,
  onOpenRefill,
  onChanged,
}: {
  row: BookingSummary;
  lang: "ar" | "en";
  onOpenRefill: () => void;
  onChanged: () => void;
}) {
  const { c } = useI18n();
  const h = c.history;

  const [busy, setBusy] = useState<"cancel" | "reschedule" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const cancel = async () => {
    // The one destructive thing a customer can do to their own booking, and it
    // takes their money with it — so it asks first. `confirm` is the browser's,
    // deliberately: a bespoke modal here would be a second dialog to maintain
    // for a question with two answers.
    if (busy || !window.confirm(h.cancelConfirm)) return;
    setBusy("cancel");
    setProblem(null);
    try {
      const res = await fetch("/api/my-bookings/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: row.code }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        // The booking is gone either way; `refunded: false` only means the money
        // needs a human, and saying so beats a silent "cancelled".
        setNote(data.refunded ? h.cancelled : h.cancelledNoRefund);
        onChanged();
        return;
      }
      setProblem(refusalMessage(data, h));
    } catch {
      setProblem(h.failed);
    } finally {
      setBusy(null);
    }
  };

  const reschedule = async (startsAt: string) => {
    setPicking(false);
    setBusy("reschedule");
    setProblem(null);
    try {
      const res = await fetch("/api/my-bookings/reschedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: row.code, startsAt }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        setNote(h.rescheduled);
        onChanged();
        return;
      }
      setProblem(
        data.error === "slot-taken" || data.error === "too-soon"
          ? h.slotTaken
          : refusalMessage(data, h),
      );
    } catch {
      setProblem(h.failed);
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="rounded-[20px] bg-white p-5 text-start shadow-[0_10px_30px_rgba(184,0,7,0.05)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-lg font-extrabold text-ink">
              {row.serviceName ? pick(row.serviceName, lang) : row.code}
            </h2>
            {row.isRefill && (
              <span className="rounded-full bg-[#f7e8e8] px-2.5 py-0.5 text-[10px] font-semibold text-red">
                {h.refillBadge}
              </span>
            )}
          </div>
          <p className="mt-1 text-[13px] text-ink/55">
            {formatDateLabel(row.startsAt.slice(0, 10), lang)}
            {row.ticketNo && (
              <>
                {" · "}
                {h.ticket}{" "}
                <span className="font-semibold text-ink" dir="ltr">
                  {row.ticketNo}
                </span>
              </>
            )}
          </p>
          <p className="mt-1 text-[11px] text-ink/40" dir="ltr">
            {row.code}
          </p>
        </div>

        <div className="flex flex-col items-end gap-2">
          <span
            className={`rounded-full px-3 py-1 text-[11px] font-semibold ${
              STATUS_TONE[row.status] ?? "bg-black/[0.06] text-ink/60"
            }`}
          >
            {h.statuses[row.status] ?? row.status}
          </span>
          <span className="flex items-center gap-1 font-display text-base font-extrabold text-ink">
            <Riyal className="h-3.5 w-3.5 text-red" />
            {row.totalSar}
          </span>
        </div>
      </div>

      {/* The whole feature. Absent — not disabled — once the window lapses.
          The countdown and price are deliberately NOT here: they come back from
          the server only after the emailed code is verified, so a forwarded
          reference alone reveals nothing about the offer. */}
      {row.hasRefill && (
        <button
          type="button"
          onClick={onOpenRefill}
          className="mt-4 flex w-full items-center justify-between gap-3 rounded-[14px] bg-red-grad px-5 py-3 text-start text-sm font-bold text-white transition-opacity hover:opacity-90"
        >
          <span>{h.refillAvailable}</span>
          <span className="text-[12px] font-semibold opacity-90">{h.refillTapToView}</span>
        </button>
      )}

      {/* Absent rather than disabled once the window shuts, like the refill
          button above — but the deadline stays on screen either way, so a
          customer who lost the option can see what they missed instead of
          wondering where the buttons went. */}
      {row.canCancel && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setPicking(true)}
            disabled={busy !== null}
            className="rounded-[12px] border border-black/[0.08] px-4 py-2 text-[13px] font-semibold text-ink transition-colors hover:border-red/40 disabled:opacity-40"
          >
            {busy === "reschedule" ? h.rescheduling : h.reschedule}
          </button>
          <button
            type="button"
            onClick={() => void cancel()}
            disabled={busy !== null}
            className="rounded-[12px] px-4 py-2 text-[13px] font-semibold text-red transition-colors hover:bg-red/[0.06] disabled:opacity-40"
          >
            {busy === "cancel" ? h.cancelling : h.cancel}
          </button>
        </div>
      )}

      {row.canCancel && (
        <p className="mt-2 text-[11px] text-ink/40">
          {h.changeBy} {formatDateLabel(row.cancelBy.slice(0, 10), lang)}
        </p>
      )}

      {note && <p className="mt-3 text-[12px] font-semibold text-[#2f7a4d]">{note}</p>}
      {problem && (
        <p role="alert" className="mt-3 text-[12px] text-red">
          {problem}
        </p>
      )}

      {/* The same picker the booking flow uses, so a moved appointment obeys
          exactly the rules a new one does — opening hours, lead time, chairs. */}
      {picking && (
        <ScheduleModal
          branchId={row.branchId}
          durationMin={row.durationMin}
          initialDate={row.startsAt.slice(0, 10)}
          initialTime={null}
          onConfirm={(_date, _time, startsAt) => void reschedule(startsAt)}
          onClose={() => setPicking(false)}
        />
      )}
    </article>
  );
}

/**
 * Two steps: ask for a code, then spend it.
 *
 * The refill details never travel with the booking listing — they are fetched
 * only after the code verifies, so the reference on its own reveals nothing
 * about the offer. See app/api/my-bookings/refill/route.ts.
 */
export function RefillDialog({ code, onClose }: { code: string; onClose: () => void }) {
  const { c, lang } = useI18n();
  const h = c.history;

  const [step, setStep] = useState<"ask" | "enter">("ask");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<RefillDetails | null>(null);

  const request = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/my-bookings/otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(res.status === 429 ? h.tooMany : h.verifyMailFailed);
        return;
      }
      setSentTo(data.sentTo ?? null);
      setStep("enter");
    } catch {
      setError(h.verifyMailFailed);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (busy || otp.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/my-bookings/refill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, otp }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        setDetails(data.refill as RefillDetails);
        return;
      }
      if (data.error === "too-many-attempts") setError(h.verifyTooMany);
      else if (data.error === "no-code" || data.error === "expired") setError(h.verifyExpired);
      else setError(h.verifyWrong);
      setOtp("");
    } catch {
      setError(h.failed);
    } finally {
      setBusy(false);
    }
  };

  const countdown = details
    ? details.daysLeft <= 1
      ? h.lastDay
      : h.daysLeft.replace("{n}", String(details.daysLeft))
    : "";

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/30 px-4 py-10 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[420px] rounded-[24px] bg-white p-7 text-start shadow-[0_40px_100px_rgba(0,0,0,0.25)]"
        onClick={(e) => e.stopPropagation()}
      >
        {details ? (
          // ---- verified: the offer itself --------------------------------
          details.daysLeft > 0 ? (
            <>
              <h3 className="font-display text-xl font-extrabold text-ink">{h.refillBadge}</h3>
              <div className="mt-5 space-y-3 rounded-[16px] bg-[#fbeaea] p-5">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-ink/55">{h.refillUntil}</span>
                  <span className="text-[13px] font-semibold text-ink" dir="ltr">
                    {details.expiresAt
                      ? formatDateLabel(details.expiresAt.slice(0, 10), lang)
                      : "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-ink/55">{h.refillPrice}</span>
                  <span className="flex items-center gap-1 font-display text-base font-extrabold text-red">
                    <Riyal className="h-4 w-4" />
                    {details.priceSar}
                  </span>
                </div>
                <p className="text-[12px] font-semibold text-red">{countdown}</p>
              </div>

              {details.bookUrl && (
                <Link
                  href={details.bookUrl}
                  className="mt-5 block rounded-[12px] bg-red-grad py-3.5 text-center text-sm font-bold text-white transition-opacity hover:opacity-90"
                >
                  {h.refillCta}
                </Link>
              )}
            </>
          ) : (
            // The window closed between listing and verifying. Rare, but the
            // server is the authority and it just said no.
            <p className="text-sm text-ink/60">{h.refillGone}</p>
          )
        ) : step === "ask" ? (
          // ---- step 1: request a code ------------------------------------
          <>
            <h3 className="font-display text-xl font-extrabold text-ink">{h.verifyTitle}</h3>
            <p className="mt-2 text-sm text-ink/55">{h.verifyIntro}</p>
            <button
              type="button"
              onClick={request}
              disabled={busy}
              className={`mt-6 w-full rounded-[12px] py-3.5 text-center text-sm font-bold transition-opacity ${
                busy ? "cursor-not-allowed bg-black/[0.06] text-ink/40" : "bg-red-grad text-white hover:opacity-90"
              }`}
            >
              {busy ? h.verifySending : h.verifySend}
            </button>
          </>
        ) : (
          // ---- step 2: spend it ------------------------------------------
          <>
            <h3 className="font-display text-xl font-extrabold text-ink">{h.verifyTitle}</h3>
            <p className="mt-2 text-sm text-ink/55">
              {h.verifySentTo} <span dir="ltr">{sentTo ?? "—"}</span>
            </p>

            <label className="mt-5 block">
              <span className="mb-1.5 block text-[12px] text-ink/55">{h.verifyCodeLabel}</span>
              <input
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                onKeyDown={(e) => e.key === "Enter" && void verify()}
                dir="ltr"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                className="w-full rounded-[12px] border border-black/[0.08] px-4 py-3 text-center text-lg font-bold tracking-[0.4em] text-ink outline-none placeholder:text-ink/20 focus:border-red/40"
              />
            </label>

            <button
              type="button"
              onClick={verify}
              disabled={busy || otp.length !== 6}
              className={`mt-4 w-full rounded-[12px] py-3.5 text-center text-sm font-bold transition-opacity ${
                busy || otp.length !== 6
                  ? "cursor-not-allowed bg-black/[0.06] text-ink/40"
                  : "bg-red-grad text-white hover:opacity-90"
              }`}
            >
              {busy ? h.verifyChecking : h.verifySubmit}
            </button>

            <button
              type="button"
              onClick={request}
              disabled={busy}
              className="mt-3 w-full text-center text-[12px] text-ink/45 underline underline-offset-4 hover:text-red"
            >
              {h.verifyResend}
            </button>
          </>
        )}

        {error && (
          <p role="alert" className="mt-4 rounded-[12px] bg-red/[0.08] px-4 py-3 text-xs text-red">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-5 w-full rounded-[12px] bg-black/[0.05] py-3 text-center text-sm font-bold text-ink transition-colors hover:bg-black/[0.08]"
        >
          {c.payment.close}
        </button>
      </div>
    </div>
  );
}
