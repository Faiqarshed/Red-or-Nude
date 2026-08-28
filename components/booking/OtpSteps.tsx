"use client";

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

import { useState } from "react";
import { useI18n } from "@/lib/i18n";

export default function OtpSteps({
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
            <input
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
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
export function otpErrorMessage(error: unknown, h: ReturnType<typeof useI18n>["c"]["history"]): string {
  if (error === "too-many-attempts") return h.verifyTooMany;
  if (error === "no-code" || error === "expired") return h.verifyExpired;
  if (error === "too-many") return h.tooMany;
  return h.verifyWrong;
}
