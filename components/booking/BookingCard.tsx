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
import ScheduleModal from "@/components/booking/ScheduleModal";
import OtpSteps, { otpErrorMessage } from "@/components/booking/OtpSteps";
import { useAccount } from "@/lib/account/context";
import { Riyal } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { pick } from "@/lib/localized";
import { formatDateLabel, type BookingSummary } from "@/lib/booking";
import { localTime } from "@/lib/time";


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
/** Refusals that mean "the code was wrong", not "the request was". */
const OTP_ERRORS = new Set(["otp-required", "wrong", "no-code", "too-many-attempts"]);

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
  /**
   * The details dialog. Opened by tapping the card, and again by a cancellation
   * or a move — the same screen either way, because "what does my booking say
   * now" is the same question before and after a change. `outcome` is the line
   * that appears above it when the second route was taken.
   *
   * It stays open across the parent's refetch, so the numbers under the banner
   * are the new ones rather than a snapshot of what was just replaced.
   */
  const [details, setDetails] = useState<{ outcome?: string } | null>(null);

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
        setDetails({
          outcome:
            what === "cancel"
              ? data.refunded
                ? h.cancelled
                : h.cancelledNoRefund
              : h.rescheduled,
        });
        onChanged();
        return null;
      }
      if (data.error === "slot-taken" || data.error === "too-soon") return h.slotTaken;
      // The credential was refused rather than the request: that is the code
      // dialog's language, not the cancellation window's.
      if (OTP_ERRORS.has(data.error)) return otpErrorMessage(data.error, h);
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
    // The one destructive thing a customer can do to their own booking, and it
    // takes their money with it — so it asks first. `confirm` is the browser's,
    // deliberately: a bespoke modal here would be a second dialog to maintain
    // for a question with two answers.
    if (busy || !window.confirm(h.cancelConfirm)) return;
    if (signedIn) runNow(() => submit("cancel", { code: row.code }));
    else setGate({ kind: "cancel" });
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
        onClick={() => setDetails({})}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setDetails({});
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

      {details && (
        <div
          className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/30 px-4 py-10 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onClick={() => setDetails(null)}
        >
          <div
            className="w-full max-w-[420px] overflow-hidden rounded-[24px] bg-white text-start shadow-[0_40px_100px_rgba(0,0,0,0.25)]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Only after a change, and above everything else, because it is
                the answer to the question that opened this. */}
            {details.outcome && (
              <p
                role="status"
                className="bg-[#eaf5ee] px-7 py-4 text-[13px] font-semibold text-[#2f7a4d]"
              >
                {details.outcome}
              </p>
            )}

            {row.serviceImage && (
              // eslint-disable-next-line @next/next/no-img-element -- the URL is
              // whatever the media store returned; next/image would need every
              // one of those hosts declared up front.
              <img
                src={row.serviceImage}
                alt=""
                className="h-40 w-full object-cover"
                loading="lazy"
              />
            )}

            <div className="p-7">
              <h3 className="font-display text-xl font-extrabold text-ink">
                {row.serviceName ? pick(row.serviceName, lang) : h.detailsTitle}
              </h3>

              <dl className="mt-5 space-y-3">
                {[
                  [h.whenLabel, `${formatDateLabel(row.startsAt.slice(0, 10), lang)} · ${localTime(row.startsAt)}`],
                  [h.branchLabel, row.branchName ? pick(row.branchName, lang) : null],
                  [h.durationLabel, h.durationMin.replace("{n}", String(row.durationMin))],
                  [h.ticket, row.ticketNo],
                  [h.statusLabel, h.statuses[row.status] ?? row.status],
                  [h.referenceLabel, row.code],
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
                <p className="mt-4 text-[11px] text-ink/40">
                  {h.changeBy} {formatDateLabel(row.cancelBy.slice(0, 10), lang)}
                </p>
              )}

              <button
                type="button"
                onClick={() => setDetails(null)}
                className="mt-6 w-full rounded-[12px] bg-black/[0.05] py-3 text-center text-sm font-bold text-ink transition-colors hover:bg-black/[0.08]"
              >
                {c.payment.close}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* A guest confirms the change with a code sent to the booking's own
          address. Knowing the reference opens the booking; it does not end it. */}
      {gate && (
        <div
          className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/30 px-4 py-10 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onClick={() => setGate(null)}
        >
          <div
            className="w-full max-w-[420px] rounded-[24px] bg-white p-7 text-start shadow-[0_40px_100px_rgba(0,0,0,0.25)]"
            onClick={(e) => e.stopPropagation()}
          >
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
          </div>
        </div>
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
