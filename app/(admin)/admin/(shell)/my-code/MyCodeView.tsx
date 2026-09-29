"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, Ticket } from "lucide-react";
import { Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import type { StaffCodeView } from "@/lib/staff-codes";

const linkClass =
  "inline-flex h-12 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors sm:h-10";

export default function MyCodeView({ code, percent }: { code: StaffCodeView | null; percent: number }) {
  const { t } = useAdminI18n();
  const c = t.myCode;
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard (an http origin, or permission refused). The code is on
      // screen in large type; she can still read it off.
    }
  };


  return (
    <>
      <PageHeader title={c.title} subtitle={c.subtitle} />

      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <Card className="p-5 text-start">
          {code ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <p className="flex items-center gap-2 text-xs font-medium text-ink/55">
                  <Ticket className="h-4 w-4 text-red" strokeWidth={1.75} />
                  {c.yourCode}
                </p>
                {!code.active ? (
                  <Badge tone="danger">{c.off}</Badge>
                ) : code.used ? (
                  <Badge tone="neutral">{c.used}</Badge>
                ) : (
                  <Badge tone="success">{c.ready}</Badge>
                )}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <p className="font-mono text-3xl font-bold tracking-wider text-ink" dir="ltr">
                  {code.code}
                </p>
                <button
                  type="button"
                  onClick={copy}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-black/10 bg-white px-3 text-xs font-medium text-ink/70 transition-colors hover:bg-black/[0.03]"
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-[#1f7a4d]" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? c.copied : c.copy}
                </button>
              </div>
              <p className="mt-3 text-sm text-ink/60">
                <span className="font-semibold text-red">{percent}%</span> ·{" "}
                {c.renews.replace("{date}", code.renewsOn)}
              </p>
              <p className="mt-4 rounded-xl bg-black/[0.03] px-4 py-3 text-xs leading-relaxed text-ink/60">
                {c.personal}
              </p>
            </>
          ) : (
            <EmptyState title={c.none} body={c.noneBody} />
          )}

          {/* A new tab, so the panel she came from is still there when she is done. */}
          <div className="mt-5 flex flex-wrap gap-2">
            <a href="/booking" target="_blank" rel="noopener" className={`${linkClass} bg-red text-white hover:bg-red-dark`}>
              {c.book}
              <ExternalLink className="h-4 w-4" strokeWidth={2} />
            </a>
            <a
              href="/"
              target="_blank"
              rel="noopener"
              className={`${linkClass} border border-black/10 bg-white text-ink hover:bg-black/[0.03]`}
            >
              {c.site}
            </a>
          </div>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title={c.howTitle} />
          <ol className="divide-y divide-black/[0.05]">
            {c.steps.map(([head, body], i) => (
              <li key={i} className="flex gap-4 px-5 py-4 text-start">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-red/10 text-xs font-bold text-red">
                  {i + 1}
                </span>
                <span>
                  <span className="block text-sm font-semibold text-ink">{head}</span>
                  <span className="mt-0.5 block text-sm text-ink/60">
                    {body.replace("{percent}", String(percent))}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
