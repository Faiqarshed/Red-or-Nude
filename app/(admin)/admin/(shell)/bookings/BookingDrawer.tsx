"use client";

import { useEffect, useState, useTransition } from "react";
import { CalendarClock, Phone } from "lucide-react";
import { Badge, Button, scoreTone } from "@/components/admin/ui";
import { Drawer } from "@/components/admin/overlays";
import { useAdminI18n } from "@/lib/admin/i18n";
import { pick } from "@/lib/localized";
import { cn } from "@/lib/cn";
import { formatCountdown, localTime } from "@/lib/time";
import { setBookingStatus } from "./actions";
import RescheduleDialog from "./RescheduleDialog";
import { STATUS_TONE, type BookingReview, type BookingRow, type BookingStatus } from "./BookingsView";

// Which status a booking can move to next. Cancelled/no-show are terminal —
// reopening one would silently re-reserve a chair someone else may now hold.
const NEXT: Record<BookingStatus, BookingStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["checked_in", "completed", "no_show", "cancelled"],
  // The technician moves this one from their own screen. It stays here so an
  // admin can unstick a booking whose technician never pressed Start.
  checked_in: ["in_progress", "completed", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  no_show: [],
};

/**
 * Statuses whose appointment is still ahead of the salon and can therefore be
 * moved. A finished, cancelled or no-show booking has no future time to change.
 *
 * `checked_in` used to be here and is not any more: the move empties the
 * technician, and only a `confirmed` row gets one dealt back, so moving a
 * customer already in the chair left her with nobody's name against her for
 * good. rescheduleBooking now refuses it outright — this list is the courtesy
 * that keeps the desk from finding out by pressing the button.
 *
 * `pending` is an unpaid hold the server would allow; it stays out because a
 * hold that may never become an appointment is not worth a slot on this screen.
 */
const MOVABLE: BookingStatus[] = ["confirmed"];

/**
 * How the appointment went, for a ticket that has been ended.
 *
 * Three states, and the difference between the first two matters to whoever is
 * reading this: no invitation at all means something went wrong when the ticket
 * was ended, while an unanswered one just means the customer has not replied
 * yet. Collapsing them into one "no rating" line would hide a real fault.
 */
function ReviewPanel({ review }: { review: BookingReview | null }) {
  const { t } = useAdminI18n();
  const b = t.bookings;

  return (
    <div className="rounded-xl border border-black/[0.06] bg-white p-4">
      <p className="mb-3 text-start text-xs font-medium text-ink/60">{b.reviewTitle}</p>

      {!review ? (
        <p className="text-start text-xs text-ink/40">{b.reviewNotInvited}</p>
      ) : review.submittedAt == null ? (
        <p className="text-start text-xs text-ink/40">
          {b.reviewWaiting}
          <span className="ms-1 text-ink/30" dir="ltr">
            ({review.invitedAt.slice(0, 10)})
          </span>
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <ScorePill label={b.reviewService} value={review.serviceRating} />
            <ScorePill label={b.reviewTech} value={review.techRating} />
          </div>
          {review.comment ? (
            <p className="rounded-lg bg-black/[0.03] px-3 py-2 text-start text-xs leading-relaxed text-ink/70">
              {review.comment}
            </p>
          ) : (
            <p className="text-start text-[11px] text-ink/30">{b.reviewNoComment}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** A score out of five, or the note that this half was skipped. */
function ScorePill({ label, value }: { label: string; value: number | null }) {
  const { t } = useAdminI18n();

  return (
    <div>
      <p className="mb-1 text-[11px] text-ink/45">{label}</p>
      {value === null ? (
        <span className="text-[11px] text-ink/30">{t.bookings.reviewSkipped}</span>
      ) : (
        <Badge tone={scoreTone(value)}>
          <span dir="ltr" className="tabular-nums">
            {value} ★
          </span>
        </Badge>
      )}
    </div>
  );
}

export default function BookingDrawer({
  booking,
  canManage,
  canReschedule,
  checkinEarlyMin,
  branchId,
  onClose,
  onChanged,
}: {
  booking: BookingRow | null;
  canManage: boolean;
  /** `bookings.reschedule` — held by everyone except technicians. */
  canReschedule: boolean;
  /** `checkin_early_min`, so the drawer can count down to the unlock. */
  checkinEarlyMin: number;
  branchId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t, lang } = useAdminI18n();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  // The countdown has to move or it is worse than no countdown: a drawer left
  // open would keep promising a wait that has already elapsed. Thirty seconds
  // matches My Day; the button unlocks on its own within half a minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  if (!booking) return null;

  // The same arithmetic the server does in setBookingStatus. Kept in sync by
  // both reading `checkin_early_min` rather than by either guessing.
  const opensAt = new Date(booking.startsAt).getTime() - checkinEarlyMin * 60_000;
  const tooEarly = now < opensAt;

  const move = (status: BookingStatus) =>
    startTransition(async () => {
      setError(null);
      const reason = status === "cancelled" ? window.prompt(t.bookings.cancelReason) ?? undefined : undefined;
      const res = await setBookingStatus(booking.id, status, reason);
      if (res.ok) onChanged();
      // Check-in has one refusal a person can act on — she isn't due yet — so it
      // says when, and how long that is, rather than "something went wrong".
      else
        setError(
          res.error === "too-early"
            ? // The unlock moment, not her slot — they differ whenever
              // checkin_early_min is non-zero, and saying the wrong one is worse
              // than saying nothing.
              `${t.frontDesk.tooEarly} ${localTime(new Date(opensAt).toISOString())} · ${formatCountdown(opensAt - Date.now(), lang)}`
            : t.common.error,
        );
    });

  const rows: [string, string][] = [
    [t.bookings.code, booking.code],
    ...(booking.refillOfCode
      ? ([[t.bookings.refillOf, booking.refillOfCode]] as [string, string][])
      : []),
    [t.bookings.time, `${localTime(booking.startsAt)} – ${localTime(booking.endsAt)}`],
    [t.bookings.service, pick(booking.serviceName, lang) || "—"],
    // High up, beside the service rather than buried under the money: on this
    // screen "who is doing it" is asked about as often as "what is it".
    [t.frontDesk.technician, booking.technicianName || t.frontDesk.unassignedShort],
    [
      t.bookings.addons,
      booking.addons.length ? booking.addons.map((a) => pick(a, lang)).join("، ") : t.common.none,
    ],
    [t.bookings.source, t.bookings.sources[booking.source]],
    // Only once someone has dealt with it — an open flag lives in the strip on
    // the bookings screen, not buried in a drawer nobody has opened.
    ...(booking.noShowNote
      ? ([[t.bookings.noShowNote, booking.noShowNote]] as [string, string][])
      : []),
  ];

  return (
    <Drawer
      open
      onClose={onClose}
      title={booking.customerName || booking.customerPhone || booking.code}
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          {t.common.cancel}
        </Button>
      }
    >
      <div className="space-y-5">
        <div className="flex items-center gap-2">
          <Badge tone={STATUS_TONE[booking.status]}>{t.bookings.statuses[booking.status]}</Badge>
          <span className="ms-auto font-display text-xl font-bold tabular-nums text-ink">
            {booking.totalSar.toLocaleString("en-US")}
            <span className="ms-1 text-xs font-normal text-ink/45">{t.common.riyal}</span>
          </span>
        </div>

        {booking.customerPhone ? (
          <a
            href={`tel:${booking.customerPhone}`}
            className="flex items-center gap-2 rounded-xl border border-black/[0.06] bg-white px-4 py-3 text-sm text-ink transition-colors hover:border-sky"
          >
            <Phone className="h-4 w-4 text-ink/40" strokeWidth={1.75} />
            <span dir="ltr">{booking.customerPhone}</span>
          </a>
        ) : null}

        <dl className="divide-y divide-black/[0.05] rounded-xl border border-black/[0.06] bg-white px-4">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-4 py-3">
              <dt className="text-xs text-ink/50">{label}</dt>
              <dd className="text-end text-sm font-medium text-ink">{value}</dd>
            </div>
          ))}
        </dl>

        {booking.notes ? (
          <p className="rounded-xl bg-black/[0.03] px-4 py-3 text-start text-xs text-ink/60">
            {booking.notes}
          </p>
        ) : null}

        {/* Only once the ticket is ended. Before that there is nothing to show
            and nothing to chase — the invitation is sent by setBookingStatus at
            the moment the status becomes `completed`. */}
        {booking.status === "completed" ? (
          <ReviewPanel review={booking.review ?? null} />
        ) : null}

        {canManage && NEXT[booking.status].length > 0 ? (
          <div>
            <p className="mb-2 text-start text-xs font-medium text-ink/60">{t.bookings.changeStatus}</p>
            <div className="flex flex-wrap gap-2">
              {NEXT[booking.status].map((status) => (
                <button
                  key={status}
                  disabled={pending}
                  onClick={() => move(status)}
                  className={cn(
                    "rounded-xl border px-3 py-2 text-xs font-medium transition-colors disabled:opacity-50",
                    status === "cancelled" || status === "no_show"
                      ? "border-red/25 text-red hover:bg-red/[0.06]"
                      : "border-black/10 text-ink hover:bg-black/[0.03]",
                  )}
                >
                  {/* The one button whose label is not just its status name.
                      Pressing it is the arrival record the no-show rule
                      measures, so it says so; the badge above reads "Waiting
                      for technician". The front desk has its own screen for
                      this — /admin — and this is the fallback.

                      When she isn't due yet it carries the wait, so the answer
                      to "why can't I press this" is on the thing being pressed
                      rather than in an error that only appears after trying. */}
                  {status === "checked_in"
                    ? tooEarly
                      ? `${t.bookings.checkIn} · ${formatCountdown(opensAt - now, lang)}`
                      : t.bookings.checkIn
                    : t.bookings.statuses[status]}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* Only while there is still an appointment to move. A completed,
            cancelled or no-show booking is history — MOVABLE keeps this honest
            in one place rather than in the button's disabled attribute. */}
        {canReschedule && MOVABLE.includes(booking.status) ? (
          <div>
            <p className="mb-2 text-start text-xs font-medium text-ink/60">{t.bookings.time}</p>
            <Button variant="secondary" size="sm" onClick={() => setPicking(true)}>
              <CalendarClock className="h-4 w-4" strokeWidth={1.75} />
              {t.bookings.reschedule}
            </Button>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-xl bg-red/[0.07] px-3 py-2 text-start text-xs text-red">
            {error}
          </p>
        ) : null}
      </div>

      <RescheduleDialog
        open={picking}
        booking={booking}
        branchId={branchId}
        onClose={() => setPicking(false)}
        onDone={onChanged}
      />
    </Drawer>
  );
}
