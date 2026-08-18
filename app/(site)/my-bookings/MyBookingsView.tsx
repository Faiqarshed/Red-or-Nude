"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { Riyal } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { pick } from "@/lib/localized";
import { formatDateLabel } from "@/lib/booking";
import type { Localized } from "@/lib/localized";

// The refill button lives here and nowhere else — that is the whole point of the
// feature: it is not a catalogue item, it is something a past booking earns.
// Whether it shows, and the countdown on it, both come from the server's
// refillState() so the button can never promise what the API would refuse.

type HistoryRow = {
  code: string;
  startsAt: string;
  status: keyof ReturnType<typeof useI18n>["c"]["history"]["statuses"];
  ticketNo: string | null;
  serviceName: Localized | null;
  totalSar: number;
  isRefill: boolean;
  refill: { eligible: boolean; daysLeft: number; priceSar: number };
};

const KEY = "ron-last-booking";

const STATUS_TONE: Record<string, string> = {
  pending: "bg-black/[0.06] text-ink/60",
  confirmed: "bg-[#e8f3ec] text-[#2f7a4d]",
  in_progress: "bg-[#fdf0dc] text-[#9a6b12]",
  completed: "bg-[#eef1f6] text-[#4a5a72]",
  cancelled: "bg-red/[0.08] text-red",
  no_show: "bg-red/[0.08] text-red",
};

export default function MyBookingsView() {
  const { c, lang } = useI18n();
  const h = c.history;

  const [code, setCode] = useState("");
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lookup = useCallback(
    async (reference: string) => {
      const trimmed = reference.trim();
      if (!trimmed || loading) return;

      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/my-bookings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: trimmed }),
        });

        if (res.ok) {
          const data = await res.json();
          setRows(data.bookings as HistoryRow[]);
          // Remembered so a returning customer isn't retyping it. Not a
          // credential store — it's the same reference already in their inbox.
          localStorage.setItem(KEY, trimmed.toUpperCase());
          return;
        }

        setRows(null);
        if (res.status === 404) setError(h.notFound);
        else if (res.status === 429) setError(h.tooMany);
        else setError(h.failed);
      } catch {
        setRows(null);
        setError(h.failed);
      } finally {
        setLoading(false);
      }
    },
    [h, loading],
  );

  // Come back to the page and it picks up where it left off.
  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    if (saved) {
      setCode(saved);
      void lookup(saved);
    }
    // Only ever on mount: re-running this on every `lookup` identity change
    // would re-fetch the list after each keystroke-driven re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const forget = () => {
    localStorage.removeItem(KEY);
    setRows(null);
    setCode("");
    setError(null);
  };

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto max-w-[760px] px-6 pb-20 pt-[120px] md:px-12">
        <h1 className="text-start font-display text-3xl font-extrabold text-ink">{h.title}</h1>
        <p className="mt-2 text-start text-sm text-ink/55">{h.sub}</p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void lookup(code);
          }}
          className="mt-6 flex flex-col gap-3 sm:flex-row"
        >
          <label className="flex-1 text-start">
            <span className="mb-1.5 block text-[12px] text-ink/55">{h.codeLabel}</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              dir="ltr"
              placeholder="RON-4F2K"
              className="w-full rounded-[12px] border border-black/[0.08] bg-white px-4 py-3 text-left text-sm uppercase tracking-wider text-ink outline-none placeholder:text-ink/30 focus:border-red/40"
            />
          </label>
          <button
            type="submit"
            disabled={loading || !code.trim()}
            className={`h-[46px] self-end rounded-[12px] px-8 text-sm font-bold transition-opacity ${
              loading || !code.trim()
                ? "cursor-not-allowed bg-black/[0.06] text-ink/40"
                : "bg-red-grad text-white hover:opacity-90"
            }`}
          >
            {loading ? h.loading : h.view}
          </button>
        </form>

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-[12px] bg-red/[0.08] px-4 py-3 text-start text-xs text-red"
          >
            {error}
          </p>
        )}

        {rows && (
          <div className="mt-8 space-y-4">
            {rows.length === 0 && <p className="text-start text-sm text-ink/55">{h.empty}</p>}

            {rows.map((r) => (
              <BookingCard key={r.code} row={r} lang={lang} />
            ))}

            <button
              type="button"
              onClick={forget}
              className="mt-2 text-[12px] text-ink/45 underline underline-offset-4 hover:text-red"
            >
              {h.forget}
            </button>
          </div>
        )}
      </div>

      <SiteFooter />
    </main>
  );
}

function BookingCard({ row, lang }: { row: HistoryRow; lang: "ar" | "en" }) {
  const { c } = useI18n();
  const h = c.history;

  const countdown =
    row.refill.daysLeft <= 1 ? h.lastDay : h.daysLeft.replace("{n}", String(row.refill.daysLeft));

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

      {/* The whole feature. Absent — not disabled — once the window lapses. */}
      {row.refill.eligible && (
        <Link
          href={`/booking?refill=${row.code}`}
          className="mt-4 flex items-center justify-between gap-3 rounded-[14px] bg-red-grad px-5 py-3 text-sm font-bold text-white transition-opacity hover:opacity-90"
        >
          <span>{h.refillCta}</span>
          <span className="flex items-center gap-2 text-[12px] font-semibold opacity-90">
            <span className="flex items-center gap-1">
              <Riyal className="h-3 w-3" />
              {row.refill.priceSar}
            </span>
            <span>· {countdown}</span>
          </span>
        </Link>
      )}
    </article>
  );
}
