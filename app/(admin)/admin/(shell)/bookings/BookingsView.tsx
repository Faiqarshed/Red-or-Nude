"use client";

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, List, Plus } from "lucide-react";
import { Badge, Button, Card, EmptyState, PageHeader, scoreTone } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import { cn } from "@/lib/cn";
import { UTC_OFFSET_HOURS, localTime } from "@/lib/time";
import { pick } from "@/lib/localized";
import type { Localized } from "@/lib/db/schema";
import { resolveNoShow } from "./actions";
import BookingDrawer from "./BookingDrawer";
import WalkInDrawer from "./WalkInDrawer";

export type BookingStatus =
  | "pending"
  | "confirmed"
  | "checked_in"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show";

/** A rating invitation and, once the customer answers, what they said. */
export type BookingReview = {
  serviceRating: number | null;
  techRating: number | null;
  comment: string | null;
  invitedAt: string;
  /** Null while the invitation is still unanswered. */
  submittedAt: string | null;
};

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
  /** The booking this one refills, if any — shown so staff know why it's cheaper. */
  refillOfCode?: string | null;
  /** An admin-granted refill deadline, if one was set by hand. */
  /** What staff wrote when they cleared a no-show flag, if they wrote anything. */
  noShowNote?: string | null;
  /** Null when no invitation was ever created for this booking. */
  review?: BookingReview | null;
};

/**
 * A booking whose chair was released because nobody checked the customer in, and
 * which nobody has dealt with yet. Not date-scoped: a Friday no-show is still
 * waiting on Monday, which is the whole point of calling it unresolved.
 */
export type NoShowRow = {
  id: string;
  startsAt: string;
  serviceName: Localized | null;
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
  checked_in: "warning",
  in_progress: "info",
  completed: "success",
  cancelled: "danger",
  no_show: "danger",
};

const DAY_START_HOUR = 8;
const DAY_END_HOUR = 24;
const PX_PER_MIN = 1.1;

/**
 * A UTC timestamp as Riyadh wall clock, date and time from the *same* shift.
 *
 * Reading the date off the raw ISO string and the time off a shifted one is how
 * they end up disagreeing: a booking at 22:00 UTC is 01:00 the next day in
 * Riyadh, so the pair would read "the 19th, 01:00" for something on the 20th.
 * Current opening hours mean that cannot happen today, which is exactly why it
 * would have gone unnoticed until the hours changed.
 */
function riyadhParts(iso: string): { date: string; time: string } {
  const shifted = new Date(
    new Date(iso).getTime() + UTC_OFFSET_HOURS * 3600_000,
  ).toISOString();
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 16) };
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

/**
 * The score a customer left, on the block itself so the grid can be read without
 * hovering anything.
 *
 * Only once they have actually answered. An invitation that is still unanswered
 * is not a rating, and a grid full of empty stars would say "everyone was
 * silent" in a place where the honest answer is "we have not heard yet" — the
 * drawer is where that distinction is spelled out.
 *
 * A Badge, shrunk to fit a block that can be 22px tall. Colour alone never
 * carries it — the digit is right there, which is what makes it legible to
 * anyone who cannot tell the two backgrounds apart.
 */
function GridScore({ review }: { review: BookingReview | null }) {
  if (!review?.submittedAt || review.serviceRating === null) return null;

  return (
    <Badge
      tone={scoreTone(review.serviceRating)}
      className="shrink-0 rounded px-1 text-[10px] font-bold tabular-nums"
    >
      <span dir="ltr">{review.serviceRating}★</span>
    </Badge>
  );
}

/**
 * The chairs we gave away, and the customers still owed an answer.
 *
 * Amber rather than red, and styled after the `?denied=` banner on the dashboard
 * — the only other "pay attention" surface in the admin. It is information, not
 * a failure: the chair is already back in use by the time anyone reads this.
 *
 * Deliberately above the date toolbar and outside the day being viewed, because
 * an unresolved flag that disappears when the receptionist changes the date is
 * not a flag, it is a rumour.
 */
function NoShowStrip({ rows }: { rows: NoShowRow[] }) {
  const { t, lang } = useAdminI18n();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const resolve = (row: NoShowRow) => {
    // window.prompt, like the cancellation reason in BookingDrawer — the house
    // way to take one short string from staff. Dismissing it still resolves the
    // row, with no note: the note is optional and a cancelled prompt means
    // "nothing to add", not "changed my mind".
    const note = window.prompt(t.bookings.noShowResolvePrompt) ?? undefined;
    setBusy(row.id);
    startTransition(async () => {
      const res = await resolveNoShow({ id: row.id, note });
      setBusy(null);
      if (res.ok) router.refresh();
    });
  };

  return (
    <div
      role="status"
      className="mb-4 rounded-2xl border border-[#e8c98a] bg-[#fdf6e7] p-4"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#b7791f]" strokeWidth={2} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[#8a5a09]">
            {t.bookings.noShowTitle} ({rows.length})
          </p>
          <p className="mt-0.5 text-xs text-[#8a5a09]/75">{t.bookings.noShowHint}</p>

          <ul className="mt-3 space-y-2">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-white/70 px-3 py-2"
              >
                <span className="text-xs tabular-nums text-ink/55" dir="ltr">
                  {riyadhParts(r.startsAt).date} {riyadhParts(r.startsAt).time}
                </span>
                <span className="text-sm font-medium text-ink">
                  {r.customerName || t.common.none}
                </span>
                {r.customerPhone && (
                  <a
                    href={`tel:${r.customerPhone}`}
                    dir="ltr"
                    className="text-xs text-ink/55 underline underline-offset-2 hover:text-red"
                  >
                    {r.customerPhone}
                  </a>
                )}
                {r.serviceName && (
                  <span className="text-xs text-ink/45">{pick(r.serviceName, lang)}</span>
                )}
                <button
                  onClick={() => resolve(r)}
                  disabled={busy !== null}
                  className="ms-auto rounded-lg bg-[#b7791f] px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  {busy === r.id ? t.common.saving : t.bookings.noShowResolve}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export default function BookingsView({
  date,
  branchId,
  branches,
  stations,
  bookings,
  noShows,
  catalog,
  canManage,
}: {
  date: string;
  branchId: string;
  branches: { id: string; name: Localized }[];
  stations: { id: string; label: string }[];
  bookings: BookingRow[];
  /** Unresolved no-shows across every date, not just the one being viewed. */
  noShows: NoShowRow[];
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

  /**
   * What a block says on hover, in the one place the grid has no room to print.
   *
   * A plain `title` attribute rather than a tooltip component: the browser
   * already positions, delays and dismisses these, and gets it right on a
   * trackpad, a touch device and a screen reader without a line of our code.
   *
   * The status line is the point. Pending and confirmed both occupy a chair and
   * both used to render identically, so "is this actually booked, or is someone
   * holding it without paying?" could only be answered by opening the drawer.
   */
  const tooltip = (b: BookingRow) =>
    [
      `${localTime(b.startsAt)} – ${localTime(b.endsAt)}`,
      b.customerName || b.customerPhone || b.code,
      pick(b.serviceName, lang),
      `${t.bookings.status}: ${t.bookings.statuses[b.status]}`,
      b.status === "pending" ? t.bookings.pendingHint : null,
      `${t.bookings.total}: ${b.totalSar.toLocaleString("en-US")} ${t.common.riyal}`,
      b.review?.submittedAt && b.review.serviceRating !== null
        ? `${t.bookings.reviewTitle}: ${b.review.serviceRating} / 5`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

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

      {canManage && noShows.length > 0 && <NoShowStrip rows={noShows} />}

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
                                  // A pending booking is a chair held for someone
                                  // who has not paid. It occupies the grid exactly
                                  // like a confirmed one, so until now the only way
                                  // to tell them apart was to open the drawer.
                                  : b.status === "pending"
                                    ? "border-dashed border-[#b7791f]/50 bg-[#fdf6e7]"
                                    : "border-red/25 bg-red/[0.07]",
                            )}
                            title={tooltip(b)}
                          >
                            {/* The score sits on the name's line rather than in a
                                corner: a block can be as short as 22px, and the
                                name truncates around it instead of running
                                underneath it. */}
                            <span className="flex items-center gap-1">
                              <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-ink">
                                {b.customerName || b.customerPhone || b.code}
                              </span>
                              <GridScore review={b.review ?? null} />
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
