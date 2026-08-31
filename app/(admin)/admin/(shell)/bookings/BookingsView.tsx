"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, List, Plus } from "lucide-react";
import { Badge, Button, Card, EmptyState, PageHeader, Thumb, scoreTone } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import { cn } from "@/lib/cn";
import { UTC_OFFSET_HOURS, localTime, riyadhDateKey } from "@/lib/time";
import { pick } from "@/lib/localized";
import type { Localized } from "@/lib/db/schema";
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
  /** Design if she picked one, else the service's picture. Often null. */
  imageUrl?: string | null;
  /**
   * Who is doing it. Null is a real state, not missing data: the morning run
   * hasn't reached a future booking yet, and a walk-in is picked at check-in.
   */
  technicianName?: string | null;
};

/**
 * A booking whose chair was released because nobody checked the customer in, and
 * which nobody has dealt with yet. Not date-scoped: a Friday no-show is still
 * waiting on Monday, which is the whole point of calling it unresolved.
 */
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
/** Cancelled and no-show rows per page. Enough to scan, few enough to scroll. */
const DROPPED_PER_PAGE = 10;

/**
 * The day as a table, whichever set of rows it is being asked about.
 *
 * One component for the booked tab and the cancelled one so the two can never
 * drift into looking like different screens — the difference between them is
 * which rows they are handed, and it should stay only that.
 */
function BookingTable({
  rows,
  empty,
  onSelect,
}: {
  rows: BookingRow[];
  empty: string;
  onSelect: (b: BookingRow) => void;
}) {
  const { t, lang } = useAdminI18n();

  if (rows.length === 0) {
    return <EmptyState title={empty} icon={<CalendarDays className="h-8 w-8" strokeWidth={1.25} />} />;
  }

  return (
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
                  {rows.map((b) => (
                    <tr
                      key={b.id}
                      onClick={() => onSelect(b)}
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
  );
}

export default function BookingsView({
  date,
  branchId,
  branches,
  stations,
  bookings,
  noShowCount,
  catalog,
  canManage,
  canReschedule,
  checkinEarlyMin,
}: {
  date: string;
  branchId: string;
  branches: { id: string; name: Localized }[];
  stations: { id: string; label: string }[];
  bookings: BookingRow[];
  /** Unresolved no-shows across every date, not just the one being viewed. */
  /** Unresolved no-show flags for this role's branches, on any date. */
  noShowCount: number;
  catalog: { services: CatalogOption[]; addons: CatalogOption[]; removals: CatalogOption[] };
  canManage: boolean;
  /** `bookings.reschedule`. Separate from canManage — a technician has neither,
   *  but the two came apart so admin could hold one without the other. */
  canReschedule: boolean;
  /** `checkin_early_min` — how many minutes before her slot check-in unlocks. */
  checkinEarlyMin: number;
}) {
  const { t, lang } = useAdminI18n();
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  const [view, setView] = useState<"day" | "list">("day");
  const [tab, setTab] = useState<"booked" | "dropped">("booked");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<BookingRow | null>(null);
  const [walkIn, setWalkIn] = useState(false);

  // The salon's today, not the browser's: a receptionist on a laptop still set
  // to another timezone must not be sent to yesterday's board.
  const todayKey = riyadhDateKey(new Date());

  const go = (next: { date?: string; branch?: string }) => {
    const sp = new URLSearchParams(params.toString());
    if (next.date) sp.set("date", next.date);
    if (next.branch) sp.set("branch", next.branch);
    startTransition(() => router.push(`/admin/bookings?${sp.toString()}`));
  };

  const hours = Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_, i) => DAY_START_HOUR + i);
  const active = bookings.filter((b) => b.status !== "cancelled" && b.status !== "no_show");

  /**
   * Cancelled and no-show, kept out of the day.
   *
   * They were mixed into the same table as everything else, which made a busy
   * day read as a bad one: eleven rows, four of them struck-through, and the
   * receptionist scanning past the ones that are not happening. They are still
   * the day's record and still openable — a no-show is what a refund argument
   * turns on — so they move to their own tab rather than out of the screen.
   *
   * The calendar has never shown them: a cancelled booking holds no chair. That
   * is also why this tab has no day view to switch to.
   */
  const dropped = bookings.filter((b) => b.status === "cancelled" || b.status === "no_show");

  // Clamped rather than reset from an effect: changing the date re-renders this
  // component with a shorter list and a page number that no longer exists, and
  // clamping answers that without a second render to correct itself.
  const pageCount = Math.max(1, Math.ceil(dropped.length / DROPPED_PER_PAGE));
  const safePage = Math.min(page, pageCount);
  const pageRows = dropped.slice((safePage - 1) * DROPPED_PER_PAGE, safePage * DROPPED_PER_PAGE);

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
      `${t.frontDesk.technician}: ${b.technicianName ?? t.frontDesk.unassignedShort}`,
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
        subtitle={`${active.length} ${t.bookings.onThisDay}`}
        action={
          canManage ? (
            <Button onClick={() => setWalkIn(true)}>
              <Plus className="h-4 w-4" strokeWidth={2} />
              {t.bookings.walkIn}
            </Button>
          ) : null
        }
      />

      {/* A pointer, not the queue itself. Eighteen unresolved flags used to be
          listed here in full and pushed the day off the bottom of the screen —
          they live at /admin/no-shows now. The line stays because the desk has
          to learn the backlog exists without going looking for it. */}
      {canManage && noShowCount > 0 ? (
        <Link
          href="/admin/no-shows"
          className="mb-4 flex items-center gap-2.5 rounded-2xl border border-[#e8c98a] bg-[#fdf6e7] px-4 py-3 transition-colors hover:bg-[#fbf0d9]"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-[#b7791f]" strokeWidth={2} />
          <span className="text-sm font-semibold text-[#8a5a09]">{t.bookings.noShowTitle}</span>
          <span className="rounded-full bg-[#b7791f]/20 px-2 py-0.5 text-xs font-semibold tabular-nums text-[#8a5a09]">
            {noShowCount}
          </span>
          <span className="ms-auto flex items-center gap-1 text-xs font-medium text-[#8a5a09]">
            {t.bookings.noShowReview}
            <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" strokeWidth={2} />
          </span>
        </Link>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-xl border border-black/[0.06] bg-white p-1">
          <button
            onClick={() => go({ date: shiftDate(date, -1) })}
            className="grid h-8 w-8 place-items-center rounded-lg text-ink/50 hover:bg-black/[0.04]"
            aria-label={t.bookings.prevDay}
          >
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" strokeWidth={2} />
          </button>
          {/* A real date input, not the plain text this used to be. The arrows
              are fine for "yesterday" and useless for "the 14th of next month",
              which is most of what the desk is asked on the phone. Native, so
              it opens the platform's own calendar and keeps the keyboard path
              for anyone who would rather type.

              `showPicker()` on click because browsers only open the calendar
              from the small icon otherwise, and the whole control looks
              clickable. It is guarded: Firefox has no such method, and Safari
              throws if the call isn't from a user gesture. */}
          <input
            type="date"
            value={date}
            onChange={(e) => e.target.value && go({ date: e.target.value })}
            onClick={(e) => {
              const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
              try {
                el.showPicker?.();
              } catch {
                /* not supported here, or not a trusted gesture — the icon still works */
              }
            }}
            aria-label={t.bookings.date}
            className="min-w-[130px] cursor-pointer rounded-lg bg-transparent px-2 text-center text-sm font-medium tabular-nums text-ink outline-none focus:bg-black/[0.03]"
            dir="ltr"
          />
          <button
            onClick={() => go({ date: shiftDate(date, 1) })}
            className="grid h-8 w-8 place-items-center rounded-lg text-ink/50 hover:bg-black/[0.04]"
            aria-label={t.bookings.nextDay}
          >
            <ChevronRight className="h-4 w-4 rtl:rotate-180" strokeWidth={2} />
          </button>
        </div>

        {/* The way back. Jumping a month ahead is now one click, so returning
            should not be thirty — and hidden while it would do nothing. */}
        {date !== todayKey ? (
          <Button variant="secondary" size="sm" onClick={() => go({ date: todayKey })}>
            {t.bookings.jumpToday}
          </Button>
        ) : null}

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

        {tab === "booked" ? (
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
        ) : null}
      </div>

      {/* The tabs sit at the start, under the date toolbar and above the thing
          they switch: they choose what the card below shows, not what the date
          controls above them do. */}
      <div className="mb-4 flex">
        <div className="flex gap-1 rounded-xl border border-black/[0.06] bg-white p-1">
          {(["booked", "dropped"] as const).map((k) => (
            <button
              key={k}
              onClick={() => {
                setTab(k);
                setPage(1);
              }}
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                tab === k ? "bg-red/[0.07] text-red" : "text-ink/55 hover:bg-black/[0.03]",
              )}
            >
              {k === "booked" ? t.bookings.tabBooked : t.bookings.tabDropped}
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                  tab === k ? "bg-red/10 text-red" : "bg-black/[0.05] text-ink/50",
                )}
              >
                {k === "booked" ? active.length : dropped.length}
              </span>
            </button>
          ))}
        </div>
      </div>

      {stations.length === 0 ? (
        <Card>
          <EmptyState title={t.bookings.noStations} body={t.bookings.noStationsBody} />
        </Card>
      ) : tab === "dropped" ? (
        <Card className="overflow-hidden">
          <BookingTable rows={pageRows} empty={t.bookings.droppedEmpty} onSelect={setSelected} />
          {dropped.length > DROPPED_PER_PAGE ? (
            <div className="flex items-center justify-between gap-3 border-t border-black/[0.06] px-4 py-3">
              <p className="text-xs tabular-nums text-ink/50">
                {t.bookings.pageOf(
                  (safePage - 1) * DROPPED_PER_PAGE + 1,
                  Math.min(safePage * DROPPED_PER_PAGE, dropped.length),
                  dropped.length,
                )}
              </p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(safePage - 1)}
                  disabled={safePage <= 1}
                  aria-label={t.bookings.prevPage}
                  className="grid h-8 w-8 place-items-center rounded-lg text-ink/50 transition-colors hover:bg-black/[0.04] disabled:text-ink/20 disabled:hover:bg-transparent"
                >
                  <ChevronLeft className="h-4 w-4 rtl:rotate-180" strokeWidth={2} />
                </button>
                <span className="px-1 text-xs tabular-nums text-ink/60">
                  {safePage} / {pageCount}
                </span>
                <button
                  onClick={() => setPage(safePage + 1)}
                  disabled={safePage >= pageCount}
                  aria-label={t.bookings.nextPage}
                  className="grid h-8 w-8 place-items-center rounded-lg text-ink/50 transition-colors hover:bg-black/[0.04] disabled:text-ink/20 disabled:hover:bg-transparent"
                >
                  <ChevronRight className="h-4 w-4 rtl:rotate-180" strokeWidth={2} />
                </button>
              </div>
            </div>
          ) : null}
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
          <BookingTable rows={active} empty={t.bookings.empty} onSelect={setSelected} />
        </Card>
      )}

      <BookingDrawer
        booking={selected}
        canManage={canManage}
        canReschedule={canReschedule}
        checkinEarlyMin={checkinEarlyMin}
        branchId={branchId}
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
