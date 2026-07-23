"use client";

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarDays, ChevronLeft, ChevronRight, List, Plus } from "lucide-react";
import { Badge, Button, Card, EmptyState, PageHeader } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import { cn } from "@/lib/cn";
import { pick } from "@/lib/localized";
import type { Localized } from "@/lib/db/schema";
import BookingDrawer from "./BookingDrawer";
import WalkInDrawer from "./WalkInDrawer";

export type BookingStatus =
  | "pending"
  | "confirmed"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show";

export type BookingRow = {
  id: string;
  code: string;
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  source: "web" | "walk_in" | "phone";
  stationId: string | null;
  serviceName: Localized | null;
  addons: Localized[];
  totalSar: number;
  notes: string | null;
  customerName: string | null;
  customerPhone: string | null;
};

export type CatalogOption = {
  id: string;
  name: Localized;
  priceSar: number;
  durationMin: number;
};

/** Status colours are their own scale — a cancelled booking must not read as "on brand". */
export const STATUS_TONE: Record<BookingStatus, "neutral" | "info" | "success" | "warning" | "danger"> = {
  pending: "warning",
  confirmed: "info",
  in_progress: "info",
  completed: "success",
  cancelled: "danger",
  no_show: "danger",
};

const DAY_START_HOUR = 8;
const DAY_END_HOUR = 24;
const PX_PER_MIN = 1.1;

function localTime(iso: string): string {
  // Timestamps arrive as UTC; the salon works in Riyadh (UTC+3, no DST).
  return new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(11, 16);
}

function minutesFromDayStart(iso: string): number {
  const [h, m] = localTime(iso).split(":").map(Number);
  return (h - DAY_START_HOUR) * 60 + m;
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default function BookingsView({
  date,
  branchId,
  branches,
  stations,
  bookings,
  catalog,
  canManage,
}: {
  date: string;
  branchId: string;
  branches: { id: string; name: Localized }[];
  stations: { id: string; label: string }[];
  bookings: BookingRow[];
  catalog: { services: CatalogOption[]; addons: CatalogOption[]; removals: CatalogOption[] };
  canManage: boolean;
}) {
  const { t, lang } = useAdminI18n();
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  const [view, setView] = useState<"day" | "list">("day");
  const [selected, setSelected] = useState<BookingRow | null>(null);
  const [walkIn, setWalkIn] = useState(false);

  const go = (next: { date?: string; branch?: string }) => {
    const sp = new URLSearchParams(params.toString());
    if (next.date) sp.set("date", next.date);
    if (next.branch) sp.set("branch", next.branch);
    startTransition(() => router.push(`/admin/bookings?${sp.toString()}`));
  };

  const hours = Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_, i) => DAY_START_HOUR + i);
  const active = bookings.filter((b) => b.status !== "cancelled" && b.status !== "no_show");

  return (
    <>
      <PageHeader
        title={t.bookings.title}
        subtitle={`${bookings.length} ${t.bookings.onThisDay}`}
        action={
          canManage ? (
            <Button onClick={() => setWalkIn(true)}>
              <Plus className="h-4 w-4" strokeWidth={2} />
              {t.bookings.walkIn}
            </Button>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-xl border border-black/[0.06] bg-white p-1">
          <button
            onClick={() => go({ date: shiftDate(date, -1) })}
            className="grid h-8 w-8 place-items-center rounded-lg text-ink/50 hover:bg-black/[0.04]"
            aria-label={t.bookings.prevDay}
          >
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" strokeWidth={2} />
          </button>
          <span className="min-w-[110px] px-2 text-center text-sm font-medium tabular-nums text-ink" dir="ltr">
            {date}
          </span>
          <button
            onClick={() => go({ date: shiftDate(date, 1) })}
            className="grid h-8 w-8 place-items-center rounded-lg text-ink/50 hover:bg-black/[0.04]"
            aria-label={t.bookings.nextDay}
          >
            <ChevronRight className="h-4 w-4 rtl:rotate-180" strokeWidth={2} />
          </button>
        </div>

        {branches.length > 1 && (
          <select
            value={branchId}
            onChange={(e) => go({ branch: e.target.value })}
            className="h-10 rounded-xl border border-black/[0.06] bg-white px-3 text-sm text-ink outline-none"
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {pick(b.name, lang)}
              </option>
            ))}
          </select>
        )}

        <div className="ms-auto flex gap-1 rounded-xl border border-black/[0.06] bg-white p-1">
          {(["day", "list"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                view === v ? "bg-red/[0.07] text-red" : "text-ink/55 hover:bg-black/[0.03]",
              )}
            >
              {v === "day" ? <CalendarDays className="h-3.5 w-3.5" /> : <List className="h-3.5 w-3.5" />}
              {v === "day" ? t.bookings.dayView : t.bookings.listView}
            </button>
          ))}
        </div>
      </div>

      {stations.length === 0 ? (
        <Card>
          <EmptyState title={t.bookings.noStations} body={t.bookings.noStationsBody} />
        </Card>
      ) : view === "day" ? (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <div className="flex min-w-[640px]">
              {/* Hour gutter */}
              <div className="w-14 shrink-0 border-e border-black/[0.06] pt-9">
                {hours.map((h) => (
                  <div
                    key={h}
                    style={{ height: 60 * PX_PER_MIN }}
                    className="relative text-end pe-2"
                  >
                    <span className="absolute -top-2 end-2 text-[10px] tabular-nums text-ink/35" dir="ltr">
                      {String(h).padStart(2, "0")}:00
                    </span>
                  </div>
                ))}
              </div>

              {/* One column per chair — capacity is visible at a glance. */}
              {stations.map((station) => (
                <div key={station.id} className="min-w-[120px] flex-1 border-e border-black/[0.04] last:border-0">
                  <div className="sticky top-0 h-9 border-b border-black/[0.06] bg-white px-2 py-2 text-center text-[11px] font-semibold text-ink/60">
                    {t.bookings.station} {station.label}
                  </div>
                  <div className="relative" style={{ height: (DAY_END_HOUR - DAY_START_HOUR) * 60 * PX_PER_MIN }}>
                    {hours.map((h) => (
                      <div
                        key={h}
                        style={{ top: (h - DAY_START_HOUR) * 60 * PX_PER_MIN }}
                        className="absolute inset-x-0 border-t border-black/[0.04]"
                      />
                    ))}

                    {active
                      .filter((b) => b.stationId === station.id)
                      .map((b) => {
                        const top = minutesFromDayStart(b.startsAt) * PX_PER_MIN;
                        const height =
                          ((new Date(b.endsAt).getTime() - new Date(b.startsAt).getTime()) / 60000) *
                          PX_PER_MIN;
                        return (
                          <button
                            key={b.id}
                            onClick={() => setSelected(b)}
                            style={{ top, height: Math.max(height, 22) }}
                            className={cn(
                              "absolute inset-x-1 overflow-hidden rounded-lg border px-2 py-1 text-start transition-shadow hover:shadow-md",
                              b.status === "completed"
                                ? "border-[#1f7a4d]/30 bg-[#1f7a4d]/10"
                                : b.status === "in_progress"
                                  ? "border-sky/40 bg-sky/15"
                                  : "border-red/25 bg-red/[0.07]",
                            )}
                          >
                            <span className="block truncate text-[11px] font-semibold text-ink">
                              {b.customerName || b.customerPhone || b.code}
                            </span>
                            <span className="block truncate text-[10px] text-ink/55">
                              {pick(b.serviceName, lang)}
                            </span>
                          </button>
                        );
                      })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {bookings.length === 0 ? (
            <EmptyState title={t.bookings.empty} icon={<CalendarDays className="h-8 w-8" strokeWidth={1.25} />} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-black/[0.06] bg-black/[0.015]">
                    {[t.bookings.time, t.bookings.customer, t.bookings.service, t.bookings.status, t.bookings.total].map(
                      (h) => (
                        <th
                          key={h}
                          className="px-4 py-2.5 text-start text-[11px] font-semibold uppercase tracking-wide text-ink/45"
                        >
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {bookings.map((b) => (
                    <tr
                      key={b.id}
                      onClick={() => setSelected(b)}
                      className="cursor-pointer border-b border-black/[0.04] last:border-0 hover:bg-black/[0.015]"
                    >
                      <td className="whitespace-nowrap px-4 py-3 text-start tabular-nums text-ink" dir="ltr">
                        {localTime(b.startsAt)}
                      </td>
                      <td className="px-4 py-3 text-start">
                        <span className="block text-ink">{b.customerName || "—"}</span>
                        <span className="block text-[11px] text-ink/45" dir="ltr">
                          {b.customerPhone}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-start text-ink/70">{pick(b.serviceName, lang)}</td>
                      <td className="px-4 py-3 text-start">
                        <Badge tone={STATUS_TONE[b.status]}>{t.bookings.statuses[b.status]}</Badge>
                      </td>
                      <td className="px-4 py-3 text-start font-semibold tabular-nums text-ink">
                        {b.totalSar.toLocaleString("en-US")}
                        <span className="ms-1 text-xs font-normal text-ink/45">{t.common.riyal}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <BookingDrawer
        booking={selected}
        canManage={canManage}
        onClose={() => setSelected(null)}
        onChanged={() => {
          setSelected(null);
          router.refresh();
        }}
      />

      <WalkInDrawer
        open={walkIn}
        branchId={branchId}
        date={date}
        catalog={catalog}
        onClose={() => setWalkIn(false)}
        onCreated={() => {
          setWalkIn(false);
          router.refresh();
        }}
      />
    </>
  );
}
