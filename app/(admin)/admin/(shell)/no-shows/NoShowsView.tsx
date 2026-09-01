"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ChevronLeft, ChevronRight, UserX } from "lucide-react";
import { Badge, BranchFilter, Button, Card, EmptyState, PageHeader } from "@/components/admin/ui";
import { Dialog } from "@/components/admin/overlays";
import RescheduleDialog from "../bookings/RescheduleDialog";
import { useAdminI18n } from "@/lib/admin/i18n";
import { pick } from "@/lib/localized";
import { localTime, riyadhDateKey } from "@/lib/time";
import { cn } from "@/lib/cn";
import type { Localized } from "@/lib/db/schema";
import { rescheduleNoShow, resolveNoShow } from "../bookings/actions";

export type NoShowTab = "open" | "resolved";

export type NoShowRow = {
  id: string;
  branchId: string;
  startsAt: string;
  endsAt: string;
  serviceName: Localized | null;
  customerName: string | null;
  customerPhone: string | null;
  /** What the salon wrote down when it closed the flag. */
  note: string | null;
  /** Null while the flag is still open. */
  resolvedAt: string | null;
};

export default function NoShowsView({
  rows,
  tab,
  openCount,
  resolvedCount,
  page,
  perPage,
  canReschedule,
  branchId,
  branchOptions,
}: {
  rows: NoShowRow[];
  tab: NoShowTab;
  openCount: number;
  resolvedCount: number;
  page: number;
  perPage: number;
  /** `bookings.reschedule` — not admin. Without it the flag is still
   *  resolvable, just not by moving the appointment. */
  canReschedule: boolean;
  /** Null = every branch. Only the CEO ever sees anything but their own. */
  branchId: string | null;
  branchOptions: { id: string; name: Localized }[];
}) {
  const { t, lang } = useAdminI18n();
  const b = t.bookings;
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Resolving asks a question before it does anything: there are two honest
  // answers to a missed appointment, and one button used to pick one silently.
  // `mode` is which half of that question is on screen.
  const [chosen, setChosen] = useState<NoShowRow | null>(null);
  const [mode, setMode] = useState<"choose" | "reason">("choose");
  const [reason, setReason] = useState("");
  const [moving, setMoving] = useState<NoShowRow | null>(null);

  const total = tab === "resolved" ? resolvedCount : openCount;
  const pageCount = Math.max(1, Math.ceil(total / perPage));

  const openResolve = (row: NoShowRow) => {
    setChosen(row);
    setMode("choose");
    setReason("");
  };

  const closeResolve = () => {
    setChosen(null);
    setMode("choose");
    setReason("");
  };

  const cancelIt = () => {
    if (!chosen || !reason.trim()) return;
    setBusy(chosen.id);
    startTransition(async () => {
      const res = await resolveNoShow({ id: chosen.id, note: reason });
      setBusy(null);
      closeResolve();
      if (res.ok) router.refresh();
    });
  };

  return (
    <>
      <PageHeader
        title={b.noShowTitle}
        subtitle={b.noShowSubtitle}
        action={
          <div className="flex items-center gap-2">
            <BranchFilter
              branchId={branchId}
              options={branchOptions}
              allLabel={t.topbar.allBranches}
              lang={lang}
              onChange={(id) => {
                const q = new URLSearchParams(window.location.search);
                if (id) q.set("branch", id);
                else q.delete("branch");
                q.delete("page");
                router.push(`/admin/no-shows?${q.toString()}`);
              }}
            />
            {openCount > 0 ? (
            <span className="rounded-xl bg-[#b7791f]/14 px-3 py-1.5 text-xs font-semibold tabular-nums text-[#8a5a06]">
              {b.noShowPending(openCount)}
              </span>
            ) : null}
          </div>
        }
      />

      {/* Tabs, not a filter dropdown: there are exactly two states a flag can be
          in, and a resolved one is still worth reading — what the salon lost,
          and what it did about it. Links rather than buttons, because the split
          happens in the query and the page number belongs to one side of it. */}
      <div className="mb-4 flex">
        <div className="flex gap-1 rounded-xl border border-black/[0.06] bg-white p-1">
          {(["open", "resolved"] as const).map((k) => (
            <Link
              key={k}
              href={noShowHref(k, branchId)}
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                tab === k ? "bg-red/[0.07] text-red" : "text-ink/55 hover:bg-black/[0.03]",
              )}
            >
              {k === "open" ? b.noShowTabOpen : b.noShowTabResolved}
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                  tab === k ? "bg-red/10 text-red" : "bg-black/[0.05] text-ink/50",
                )}
              >
                {k === "open" ? openCount : resolvedCount}
              </span>
            </Link>
          ))}
        </div>
      </div>

      {tab === "open" ? (
        <p className="mb-4 text-start text-xs text-ink/55">{b.noShowHint}</p>
      ) : null}

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title={tab === "resolved" ? b.noShowNoneResolved : b.noShowEmpty}
            icon={<UserX className="h-8 w-8" strokeWidth={1.25} />}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-black/[0.06] bg-black/[0.015]">
                  {[b.date, b.customer, b.service, b.status].map((h) => (
                    <th
                      key={h}
                      className="px-4 py-2.5 text-start text-[11px] font-semibold uppercase tracking-wide text-ink/45"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-black/[0.04] last:border-0">
                    <td
                      className="whitespace-nowrap px-4 py-3 align-top text-start tabular-nums text-ink"
                      dir="ltr"
                    >
                      {riyadhDateKey(new Date(r.startsAt))}{" "}
                      <span className="text-ink/50">{localTime(r.startsAt)}</span>
                    </td>
                    <td className="px-4 py-3 align-top text-start">
                      <span className="block text-ink">{r.customerName || "—"}</span>
                      <span className="block text-[11px] text-ink/45" dir="ltr">
                        {r.customerPhone}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-top text-start text-ink/70">
                      {pick(r.serviceName, lang)}
                    </td>
                    <td className="px-4 py-3 align-top text-start">
                      {r.resolvedAt ? (
                        <>
                          <Badge tone="success">{b.noShowTabResolved}</Badge>
                          {/* The reason is the point of the resolved tab: a list
                              of green badges says nothing a count could not. */}
                          {r.note ? (
                            <span className="mt-1.5 block max-w-sm text-xs leading-relaxed text-ink/70">
                              {r.note}
                            </span>
                          ) : null}
                          <span className="mt-1 block text-[11px] tabular-nums text-ink/40" dir="ltr">
                            {b.noShowResolvedOn} {riyadhDateKey(new Date(r.resolvedAt))}
                          </span>
                        </>
                      ) : (
                        <div className="flex items-center gap-3">
                          <Badge tone="warning">{b.noShowTabOpen}</Badge>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => openResolve(r)}
                            disabled={busy === r.id}
                          >
                            {b.noShowResolve}
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > perPage ? (
          <div className="flex items-center justify-between gap-3 border-t border-black/[0.06] px-4 py-3">
            <p className="text-xs tabular-nums text-ink/50">
              {b.pageOf((page - 1) * perPage + 1, Math.min(page * perPage, total), total)}
            </p>
            <div className="flex items-center gap-1">
              <Pager tab={tab} branchId={branchId} to={page - 1} disabled={page <= 1} label={b.prevPage}>
                <ChevronLeft className="h-4 w-4 rtl:rotate-180" strokeWidth={2} />
              </Pager>
              <span className="px-1 text-xs tabular-nums text-ink/60">
                {page} / {pageCount}
              </span>
              <Pager tab={tab} branchId={branchId} to={page + 1} disabled={page >= pageCount} label={b.nextPage}>
                <ChevronRight className="h-4 w-4 rtl:rotate-180" strokeWidth={2} />
              </Pager>
            </div>
          </div>
        ) : null}
      </Card>

      <Dialog
        open={!!chosen && mode === "choose"}
        onClose={closeResolve}
        title={b.noShowChoose}
        className="max-w-md"
      >
        <div className="flex flex-col gap-3 text-start">
          {/* Offered only to whoever may actually move a booking. A button that
              opens a picker and then fails on submit is worse than no button. */}
          {canReschedule ? (
          <button
            onClick={() => {
              setMoving(chosen);
              closeResolve();
            }}
            className="rounded-2xl border border-black/10 bg-white p-4 text-start transition-colors hover:border-red/30 hover:bg-black/[0.02]"
          >
            <span className="block text-sm font-semibold text-ink">{b.reschedule}</span>
            <span className="mt-1 block text-xs text-ink/55">{b.noShowRescheduleHint}</span>
          </button>
          ) : null}

          <button
            onClick={() => setMode("reason")}
            className="rounded-2xl border border-black/10 bg-white p-4 text-start transition-colors hover:border-red/30 hover:bg-black/[0.02]"
          >
            <span className="block text-sm font-semibold text-ink">{b.noShowCancelIt}</span>
            <span className="mt-1 block text-xs text-ink/55">{b.noShowCancelHint}</span>
          </button>
        </div>
      </Dialog>

      <Dialog
        open={!!chosen && mode === "reason"}
        onClose={closeResolve}
        title={b.noShowCancelIt}
        className="max-w-md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setMode("choose")}>
              {t.common.cancel}
            </Button>
            {/* Required, not optional: the reason is the whole of what this
                button records, and an empty one closes the flag saying nothing
                about why the salon lost the hour. */}
            <Button onClick={cancelIt} disabled={!reason.trim() || busy === chosen?.id}>
              {b.noShowResolve}
            </Button>
          </>
        }
      >
        <label className="block text-start">
          <span className="mb-1.5 block text-xs font-medium text-ink/70">
            {b.noShowReasonLabel}
          </span>
          <textarea
            autoFocus
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink/35 focus:border-sky focus:ring-2 focus:ring-sky/20"
          />
        </label>
        <p className="mt-2 text-start text-xs text-ink/45">{b.noShowCancelHint}</p>
      </Dialog>

      {/* The salon's own picker, pointed at the action that un-misses the
          appointment as it moves it. */}
      <RescheduleDialog
        open={!!moving}
        booking={moving}
        branchId={moving?.branchId ?? ""}
        submit={rescheduleNoShow}
        onClose={() => setMoving(null)}
        onDone={() => {
          setMoving(null);
          router.refresh();
        }}
      />
    </>
  );
}

/**
 * A page step as a link, not a button.
 *
 * The page number lives in the URL because the query does — so a receptionist
 * can send "page 3" to a colleague, and coming back from a booking she opened
 * lands her where she was rather than at the top. The tab travels with it, or
 * paging on Resolved would drop her back onto Open — and so does the branch,
 * or the CEO would page out of the branch she had narrowed to.
 */
function noShowHref(tab: NoShowTab, branchId: string | null, page?: number): string {
  const q = new URLSearchParams();
  if (tab === "resolved") q.set("tab", "resolved");
  if (branchId) q.set("branch", branchId);
  if (page && page > 1) q.set("page", String(page));
  const s = q.toString();
  return s ? `/admin/no-shows?${s}` : "/admin/no-shows";
}

function Pager({
  tab,
  branchId,
  to,
  disabled,
  label,
  children,
}: {
  tab: NoShowTab;
  branchId: string | null;
  to: number;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}) {
  const base = "grid h-8 w-8 place-items-center rounded-lg transition-colors";

  if (disabled) {
    return (
      <span aria-hidden className={cn(base, "text-ink/20")}>
        {children}
      </span>
    );
  }

  const query = noShowHref(tab, branchId, to);

  return (
    <Link
      href={query}
      aria-label={label}
      className={cn(base, "text-ink/50 hover:bg-black/[0.04]")}
    >
      {children}
    </Link>
  );
}
