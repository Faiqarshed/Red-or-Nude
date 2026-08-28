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
// It does know whether someone is signed in, and only to decide which dialog to
// open: a guest confirms cancel, reschedule and refill with a code emailed to
// the booking, while a signed-in customer's session already says more than the
// code would. The server decides for real either way (lib/booking-auth.ts), so
// a stale flag here costs a round trip, never a wrong answer.

import Link from "next/link";
import { useEffect, useState } from "react";
import OtpInput from "@/components/OtpInput";
import Modal from "@/components/booking/Modal";
import ScheduleModal from "@/components/booking/ScheduleModal";
import { useAccount } from "@/lib/account/context";
import { Riyal } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { pick } from "@/lib/localized";
import { formatDateLabel, type BookingSummary } from "@/lib/booking";
import { localTime } from "@/lib/time";

/** Shared backdrop for all dialogs in BookingCard. */

/**
 * A circle, a sentence, and the buttons that answer it.
 *
 * The success and confirm dialogs were the same forty lines of centred layout
 * twice over, differing only in the colour of the ring and what the buttons
 * said.
 */
function IconDialog({
  onClose,
  tone,
  icon,
  message,
  children,
}: {
  onClose: () => void;
  tone: "good" | "warn";
  icon: React.ReactNode;
  message: string;
  children: React.ReactNode;
}) {
  return (
    <Modal onClose={onClose} chrome={false} className="max-w-[420px]">
      <div className="flex flex-col items-center px-7 py-10 text-center">
        <div
          className={`grid h-16 w-16 place-items-center rounded-full ${
            tone === "good" ? "bg-[#eaf5ee]" : "bg-red/[0.08]"
          }`}
        >
          {icon}
        </div>
        <p
          className={`mt-5 text-[15px] font-semibold ${
            tone === "good" ? "text-[#2f7a4d]" : "text-ink"
          }`}
        >
          {message}
        </p>
        {children}
      </div>
    </Modal>
  );
}

// Ask for a code, then spend it. The two steps, without a screen around them.
//
// Extracted from RefillDialog when the guest lookup needed the same pair. The
// two callers differ only in the sentence above the button and in what the six
// digits are posted to, which is what `intro` and `onSubmit` are — everything
// else, including the resend and the "we sent it to f•••@…" line, is identical
// and was never worth a second copy.
//
// Deliberately not a dialog: the refill flow needs it inside a modal, the
// lookup flow needs it inline on the page. The shell is the caller's problem.


function OtpSteps({
  code,
  intro,
  onSubmit,
}: {
  /** Booking reference the code is being sent for. */
  code: string;
  /** Why we're asking. The one line that differs between callers. */
  intro: string;
  /** Spend the code. Return a message to show, or null when it worked. */
  onSubmit: (otp: string) => Promise<string | null>;
}) {
  const { c } = useI18n();
  const h = c.history;

  const [step, setStep] = useState<"ask" | "enter">("ask");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      // The route answers the same way for a reference that does not exist, so
      // reaching step two proves nothing about the reference. That is the point.
      setSentTo(data.sentTo ?? null);
      setStep("enter");
    } catch {
      setError(h.verifyMailFailed);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (busy || otp.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const message = await onSubmit(otp);
      if (message) {
        setError(message);
        setOtp("");
      }
    } catch {
      setError(h.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3 className="font-display text-xl font-extrabold text-ink">{h.verifyTitle}</h3>

      {step === "ask" ? (
        <>
          <p className="mt-2 text-sm text-ink/55">{intro}</p>
          <button
            type="button"
            onClick={request}
            disabled={busy}
            className={`mt-6 w-full rounded-[12px] py-3.5 text-center text-sm font-bold transition-opacity ${
              busy
                ? "cursor-not-allowed bg-black/[0.06] text-ink/40"
                : "bg-red-grad text-white hover:opacity-90"
            }`}
          >
            {busy ? h.verifySending : h.verifySend}
          </button>
        </>
      ) : (
        <>
          <p className="mt-2 text-sm text-ink/55">
            {h.verifySentTo} <span dir="ltr">{sentTo ?? "—"}</span>
          </p>

          <label className="mt-5 block">
            <span className="mb-1.5 block text-[12px] text-ink/55">{h.verifyCodeLabel}</span>
            <OtpInput value={otp} onChange={setOtp} onEnter={() => void submit()} />
          </label>

          <button
            type="button"
            onClick={submit}
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
    </>
  );
}

/**
 * The shared mapping from an API refusal to something a customer can act on.
 *
 * Both callers post to different endpoints but get the same four answers back,
 * because every code-checking route returns them from the same verifyOtp().
 */
function otpErrorMessage(error: unknown, h: ReturnType<typeof useI18n>["c"]["history"]): string {
  if (error === "too-many-attempts") return h.verifyTooMany;
  if (error === "no-code" || error === "expired") return h.verifyExpired;
  if (error === "too-many") return h.tooMany;
  return h.verifyWrong;
}

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
 * The reasons are kept apart on purpose: telling someone who already cancelled
 * that their window has closed sends them looking for a deadline problem they
 * do not have. See lib/cancellation.ts.
 */
function refusalMessage(
  data: { error?: string; cutoffHours?: number },
  h: {
    windowClosed: string;
    alreadyCancelled: string;
    notCancellable: string;
    failed: string;
  },
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

  const signedIn = useAccount();
  const [busy, setBusy] = useState<"cancel" | "reschedule" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  /** The change waiting on a code, for a guest. Null for a signed-in customer. */
  const [gate, setGate] = useState<
    { kind: "cancel" } | { kind: "reschedule"; startsAt: string } | null
  >(null);
  /** The booking details dialog. Opened by tapping the card. */
  const [details, setDetails] = useState(false);
  /** Success message after a reschedule or cancel. Shown in its own modal. */
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  /** Whether the cancel confirmation dialog is open. */
  const [confirmCancel, setConfirmCancel] = useState(false);

  /**
   * Post a change. Returns a message to show, or null when it worked, because
   * the caller decides where it goes: straight onto the card for a signed-in
   * customer, or into the code dialog for a guest who is mid-verification.
   */
  const submit = async (
    what: "cancel" | "reschedule",
    payload: Record<string, unknown>,
    otp?: string,
  ): Promise<string | null> => {
    setBusy(what);
    setProblem(null);
    try {
      const res = await fetch(`/api/my-bookings/${what}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(otp ? { ...payload, otp } : payload),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        // A cancelled booking is gone either way; `refunded: false` only means
        // the money needs a human, and saying so beats a silent "cancelled".
        setGate(null);
        setConfirmCancel(false);
        setDetails(false);
        setSuccessMsg(
          what === "cancel"
            ? data.refunded
              ? h.cancelled
              : h.cancelledNoRefund
            : h.rescheduled,
        );
        onChanged();
        return null;
      }
      if (data.error === "slot-taken" || data.error === "too-soon") return h.slotTaken;
      // The credential was refused rather than the request: that is the code
      // dialog's language, not the cancellation window's.
      // Refusals that mean "the code was wrong", not "the request was".
      if (["otp-required", "wrong", "no-code", "too-many-attempts"].includes(data.error))
        return otpErrorMessage(data.error, h);
      return refusalMessage(data, h);
    } catch {
      return h.failed;
    } finally {
      setBusy(null);
    }
  };

  /** Run it now and report on the card — the signed-in path. */
  const runNow = (fn: () => Promise<string | null>) => {
    void fn().then((message) => message && setProblem(message));
  };

  const onCancelClick = () => {
    if (busy) return;
    setConfirmCancel(true);
  };

  const onCancelConfirmed = () => {
    if (signedIn) runNow(() => submit("cancel", { code: row.code }));
    else {
      setConfirmCancel(false);
      setGate({ kind: "cancel" });
    }
  };

  const onSlotPicked = (startsAt: string) => {
    setPicking(false);
    // The slot is chosen before the code is asked for, not after: a code lives
    // ten minutes, and browsing the calendar can easily outlast one.
    if (signedIn) runNow(() => submit("reschedule", { code: row.code, startsAt }));
    else setGate({ kind: "reschedule", startsAt });
  };

  return (
    <article className="rounded-[20px] bg-white p-5 text-start shadow-[0_10px_30px_rgba(184,0,7,0.05)]">
      {/* The heading area opens the details, not the whole card: the buttons
          below cancel and move real appointments, and a card-wide tap target
          would sit underneath them.
          
          A div with role/tabIndex rather than a <button>, because the region
          contains an <h2> and a button may only hold phrasing content. Keyboard
          activation is therefore ours to provide, hence the Enter/Space handler
          — without it this would be reachable by tab and impossible to press. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setDetails(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setDetails(true);
          }
        }}
        aria-label={h.detailsOpen}
        className="-m-1 block w-full cursor-pointer rounded-[16px] p-1 text-start transition-colors hover:bg-black/[0.02] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red/50"
      >
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
            onClick={onCancelClick}
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
          onConfirm={(_date, _time, startsAt) => onSlotPicked(startsAt)}
          onClose={() => setPicking(false)}
        />
      )}

      {/* ── Booking details popup ── */}
      {details && (
        <Modal onClose={() => setDetails(false)} chrome={false} className="max-w-[420px]">
          {/* Main Service Image Header */}
          {row.serviceImage && (
            <div className="relative h-36 w-full shrink-0 overflow-hidden bg-black/[0.04] sm:h-44">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={row.serviceImage}
                alt=""
                className="h-full w-full object-cover"
                loading="lazy"
              />
              <div className="absolute start-4 top-4 rounded-full bg-black/60 px-3 py-1 text-[11px] font-semibold text-white backdrop-blur-md">
                {h.serviceLabel}
              </div>
            </div>
          )}

          {/* min-h-0 is load-bearing: a flex child defaults to min-height:auto,
              which refuses to shrink below its content and would push the close
              button off the bottom instead of scrolling. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-7">
            <h3 className="font-display text-xl font-extrabold text-ink">
              {row.serviceName ? pick(row.serviceName, lang) : h.detailsTitle}
            </h3>

            {/* Dedicated Add-ons section with clear image thumbnails & names */}
            {row.addons.length > 0 && (
              <div className="mt-4 rounded-[16px] bg-[#FAF8F5] p-3.5 ring-1 ring-black/[0.05]">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[12px] font-bold text-ink/70">{h.addonsLabel}</span>
                  <span className="rounded-full bg-black/[0.06] px-2 py-0.5 text-[10px] font-semibold text-ink/60">
                    {row.addons.length}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {row.addons.map((addon, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-2.5 rounded-[12px] bg-white px-2.5 py-1.5 shadow-sm ring-1 ring-black/[0.04]"
                    >
                      {addon.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={addon.image}
                          alt=""
                          className="h-8 w-8 rounded-[8px] object-cover ring-1 ring-black/[0.08]"
                          loading="lazy"
                        />
                      ) : (
                        <div className="grid h-8 w-8 place-items-center rounded-[8px] bg-red/10 text-xs font-bold text-red">
                          +
                        </div>
                      )}
                      <span className="text-[13px] font-semibold text-ink">
                        {addon.name ? pick(addon.name, lang) : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <dl className="mt-5 space-y-3">
              {[
                [h.whenLabel, `${formatDateLabel(row.startsAt.slice(0, 10), lang)} · ${localTime(row.startsAt)}`],
                [h.branchLabel, row.branchName ? pick(row.branchName, lang) : null],
                [h.technicianLabel, row.technicianName || h.notAssignedYet],
                [h.durationLabel, h.durationMin.replace("{n}", String(row.durationMin))],
                [h.ticket, row.ticketNo],
                [h.statusLabel, h.statuses[row.status] ?? row.status],
              ]
                .filter(([, value]) => value)
                .map(([label, value]) => (
                  <div key={label as string} className="flex items-baseline justify-between gap-4">
                    <dt className="text-[13px] text-ink/55">{label}</dt>
                    <dd className="text-[13px] font-semibold text-ink">{value}</dd>
                  </div>
                ))}

              <div className="flex items-baseline justify-between gap-4 border-t border-black/[0.06] pt-3">
                <dt className="text-[13px] text-ink/55">{h.totalLabel}</dt>
                <dd className="flex items-center gap-1 font-display text-base font-extrabold text-red">
                  <Riyal className="h-4 w-4" />
                  {row.totalSar}
                </dd>
              </div>
            </dl>

            {row.canCancel && (
              <p className="mt-4 pb-7 text-[11px] text-ink/40">
                {h.changeBy} {formatDateLabel(row.cancelBy.slice(0, 10), lang)}
              </p>
            )}
          </div>

          {/* Outside the scroll area, so the way out is always on screen. */}
          <div className="shrink-0 border-t border-black/[0.06] p-5">
            <button
              type="button"
              onClick={() => setDetails(false)}
              className="w-full rounded-[12px] bg-black/[0.05] py-3 text-center text-sm font-bold text-ink transition-colors hover:bg-black/[0.08]"
            >
              {c.payment.close}
            </button>
          </div>
        </Modal>
      )}

      {/* ── Success modal (after reschedule / cancel) ── */}
      {successMsg && (
        <IconDialog
          onClose={() => setSuccessMsg(null)}
          tone="good"
          message={successMsg}
          icon={
            <svg viewBox="0 0 24 24" width={32} height={32} fill="none" stroke="#2f7a4d" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          }
        >
          <button
            type="button"
            onClick={() => setSuccessMsg(null)}
            className="mt-8 w-full rounded-[12px] bg-black/[0.05] py-3 text-center text-sm font-bold text-ink transition-colors hover:bg-black/[0.08]"
          >
            {h.successDone}
          </button>
        </IconDialog>
      )}

      {/* ── Cancel confirmation modal ── */}
      {confirmCancel && (
        <IconDialog
          onClose={() => setConfirmCancel(false)}
          tone="warn"
          message={h.cancelConfirm}
          icon={
            <svg viewBox="0 0 24 24" width={32} height={32} fill="none" stroke="#B80007" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          }
        >
          <button
            type="button"
            disabled={busy !== null}
            onClick={onCancelConfirmed}
            className="mt-8 w-full rounded-[12px] bg-red-grad py-3 text-center text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy === "cancel" ? h.cancelling : h.cancel}
          </button>
          <button
            type="button"
            onClick={() => setConfirmCancel(false)}
            className="mt-3 w-full rounded-[12px] bg-black/[0.05] py-3 text-center text-sm font-bold text-ink transition-colors hover:bg-black/[0.08]"
          >
            {h.cancelKeep}
          </button>
        </IconDialog>
      )}

      {/* A guest confirms the change with a code sent to the booking's own
          address. Knowing the reference opens the booking; it does not end it. */}
      {gate && (
        <Modal onClose={() => setGate(null)} chrome={false} className="max-w-[420px] p-7">
          <OtpSteps
            code={row.code}
            intro={h.verifyIntroChange}
            onSubmit={(otp) =>
              gate.kind === "cancel"
                ? submit("cancel", { code: row.code }, otp)
                : submit("reschedule", { code: row.code, startsAt: gate.startsAt }, otp)
            }
          />
          <button
            type="button"
            onClick={() => setGate(null)}
            className="mt-5 w-full rounded-[12px] bg-black/[0.05] py-3 text-center text-sm font-bold text-ink transition-colors hover:bg-black/[0.08]"
          >
            {c.payment.close}
          </button>
        </Modal>
      )}
    </article>
  );
}

/**
 * The refill offer, behind a check that the asker owns the booking.
 *
 * The details never travel with the booking listing — they are fetched only
 * after the server accepts a credential, so a reference on its own reveals
 * nothing about the offer. See app/api/my-bookings/refill/route.ts.
 *
 * The two code steps live in OtpSteps, shared with the guest lookup. A guest
 * who reached their booking by spending a code minutes ago is already carrying
 * the ticket, so the usual path through here is the one that never renders
 * them: the first request succeeds and the offer appears.
 */
export function RefillDialog({ code, onClose }: { code: string; onClose: () => void }) {
  const { c, lang } = useI18n();
  const h = c.history;

  const [details, setDetails] = useState<RefillDetails | null>(null);
  const [needsCode, setNeedsCode] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /** Ask for the offer. `otp` is absent on the first, cookie-only attempt. */
  const load = async (otp?: string): Promise<string | null> => {
    try {
      const res = await fetch("/api/my-bookings/refill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(otp ? { code, otp } : { code }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        setDetails(data.refill as RefillDetails);
        return null;
      }
      // No cookie to go on. Fall back to the code, which is the path a
      // forwarded link or an expired ticket lands on.
      if (data.error === "otp-required") {
        setNeedsCode(true);
        return null;
      }
      return otpErrorMessage(data.error, h);
    } catch {
      return h.failed;
    }
  };

  // First attempt on open, using whatever cookie the browser already has.
  useEffect(() => {
    void load().then(setProblem);
    // Once, for this booking. `load` is stable enough for that intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

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
            // The window closed between listing and asking. Rare, but the
            // server is the authority and it just said no.
            <p className="text-sm text-ink/60">{h.refillGone}</p>
          )
        ) : needsCode ? (
          <OtpSteps
            code={code}
            intro={h.verifyIntroRefill}
            onSubmit={(otp) => load(otp)}
          />
        ) : (
          <p className="text-sm text-ink/60">{h.loading}</p>
        )}

        {problem && (
          <p role="alert" className="mt-4 rounded-[12px] bg-red/[0.08] px-4 py-3 text-xs text-red">
            {problem}
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
