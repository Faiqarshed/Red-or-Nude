"use client";

import { useState } from "react";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { useI18n } from "@/lib/i18n";
import { pick, type Localized } from "@/lib/localized";
import { formatDateLabel } from "@/lib/booking";

type Submitted = {
  serviceRating: number;
  techRating: number | null;
  comment: string | null;
};

export default function ReviewForm({
  token,
  serviceName,
  startsAt,
  technicianName,
  initialRating,
  submitted,
}: {
  token: string;
  serviceName: Localized | null;
  startsAt: string;
  technicianName: string | null;
  initialRating: number | null;
  submitted: Submitted | null;
}) {
  const { c, lang } = useI18n();
  const r = c.review;

  const [serviceRating, setServiceRating] = useState(initialRating ?? 0);
  const [techRating, setTechRating] = useState(0);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Submitted | null>(submitted);

  const service = pick(serviceName, lang);
  const date = formatDateLabel(startsAt.slice(0, 10), lang);

  const submit = async () => {
    if (!serviceRating || sending) return;
    setSending(true);
    setError(null);

    try {
      const res = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          serviceRating,
          // 0 is "not answered", which is a different thing from a 1.
          techRating: techRating || null,
          comment: comment.trim() || null,
        }),
      });

      if (res.ok) {
        setDone({ serviceRating, techRating: techRating || null, comment: comment.trim() || null });
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error === "already-submitted" ? r.alreadyDone : r.failed);
    } catch {
      setError(r.failed);
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto max-w-[520px] px-6 pb-20 pt-[120px] md:px-12">
        <div className="rounded-[24px] bg-white p-7 text-center shadow-[0_20px_50px_rgba(184,0,7,0.06)]">
          <h1 className="font-display text-2xl font-extrabold text-ink">
            {done ? r.thanksTitle : r.title}
          </h1>
          <p className="mx-auto mt-2 max-w-[340px] text-sm text-ink/55">
            {done ? r.thanksSub : r.sub}
          </p>

          <p className="mt-4 text-[13px] text-ink/45">
            {service || r.yourVisit} · {date}
          </p>

          {done ? (
            // Read-only afterwards. Showing the answer back is what tells the
            // customer it landed — a page that just says "thanks" leaves anyone
            // who clicks the link twice wondering whether it saved.
            <div className="mt-6 space-y-4 text-start">
              <Stars label={r.serviceLabel} value={done.serviceRating} readOnly />
              {done.techRating !== null && (
                <Stars
                  label={technicianName ?? r.technicianLabel}
                  value={done.techRating}
                  readOnly
                />
              )}
              {done.comment && (
                <p className="rounded-[14px] bg-cream/70 p-4 text-sm italic text-ink/70">
                  &ldquo;{done.comment}&rdquo;
                </p>
              )}
            </div>
          ) : (
            <>
              <div className="mt-6 space-y-5 text-start">
                <Stars
                  label={r.serviceLabel}
                  value={serviceRating}
                  onChange={setServiceRating}
                />
                {/* Asked whether or not the booking names anyone — the customer
                    knows who served her even when the system does not. */}
                <Stars
                  label={technicianName ?? r.technicianLabel}
                  hint={r.optional}
                  value={techRating}
                  onChange={setTechRating}
                />

                <label className="block">
                  <span className="mb-1.5 block text-[12px] text-ink/55">
                    {r.commentLabel} <span className="text-ink/35">{r.optional}</span>
                  </span>
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    rows={4}
                    maxLength={1000}
                    placeholder={r.commentPlaceholder}
                    className="w-full resize-none rounded-[14px] border border-black/[0.08] px-4 py-3 text-sm text-ink outline-none placeholder:text-ink/30 focus:border-red/40"
                  />
                </label>
              </div>

              {error && (
                <p role="alert" className="mt-4 rounded-[12px] bg-red/[0.08] px-4 py-3 text-start text-xs text-red">
                  {error}
                </p>
              )}

              <button
                type="button"
                onClick={submit}
                disabled={!serviceRating || sending}
                className={`mt-6 block w-full rounded-[12px] py-3.5 text-center text-sm font-bold transition-opacity ${
                  !serviceRating || sending
                    ? "cursor-not-allowed bg-black/[0.06] text-ink/40"
                    : "bg-red-grad text-white hover:opacity-90"
                }`}
              >
                {sending ? r.sending : r.submit}
              </button>
            </>
          )}

          <Link
            href="/"
            className="mt-4 inline-block text-[12px] font-semibold text-red underline underline-offset-4"
          >
            {r.backHome}
          </Link>
        </div>
      </div>

      <SiteFooter />
    </main>
  );
}

/**
 * A five-star row. Radio inputs rather than buttons, so the whole thing is
 * keyboard-reachable and announces itself as a single choice out of five —
 * a row of unlabelled buttons is unusable with a screen reader.
 */
function Stars({
  label,
  hint,
  value,
  onChange,
  readOnly = false,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange?: (n: number) => void;
  readOnly?: boolean;
}) {
  return (
    <fieldset className="border-0 p-0">
      <legend className="mb-1.5 block text-[12px] text-ink/55">
        {label} {hint && <span className="text-ink/35">{hint}</span>}
      </legend>
      <div className="flex gap-1" dir="ltr">
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className={readOnly ? "" : "cursor-pointer"}>
            <input
              type="radio"
              name={label}
              value={n}
              checked={value === n}
              disabled={readOnly}
              onChange={() => onChange?.(n)}
              className="sr-only"
            />
            <span
              aria-label={`${n}`}
              className={`block text-3xl leading-none transition-colors ${
                n <= value ? "text-red" : "text-black/15"
              }`}
            >
              ★
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
