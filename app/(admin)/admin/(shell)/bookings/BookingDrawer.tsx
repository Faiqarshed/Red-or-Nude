"use client";

import { useEffect, useState, useTransition } from "react";
import { CalendarClock, ChevronRight, Phone, RefreshCw, Trash2, Users } from "lucide-react";
import { Badge, Button, scoreTone } from "@/components/admin/ui";
import { ConfirmDialog, Drawer } from "@/components/admin/overlays";
import TextField from "@/components/admin/TextField";
import { useAdminI18n } from "@/lib/admin/i18n";
import { CANCEL_REASON_MAX, checkNote, NOTES_TEXT } from "@/lib/admin/validate";
import { serviceClock } from "@/lib/booking-clock";
import { pick } from "@/lib/localized";
import { cn } from "@/lib/cn";
import { formatCountdown, formatDateTime, formatDuration, localTime } from "@/lib/time";
import { deleteBooking, setBookingStatus } from "./actions";
import RescheduleDialog from "./RescheduleDialog";
import type { PartnerElsewhere } from "./partners";
import type { Localized } from "@/lib/db/schema";
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

/**
 * Everything true about a booking, without any of the buttons.
 *
 * Split out of the drawer because the front desk needs exactly this twice over:
 * once when a card is opened, and once — the more important one — under the
 * ticket search, where the receptionist has a customer standing in front of her
 * and needs to say which chair and which technician. That panel used to show
 * four facts. Two copies of this list would have drifted the first time a field
 * was added to one of them.
 *
 * Every line past the first few is conditional on its own field, which is what
 * lets /admin/bookings pass a row with no timings and get a shorter list rather
 * than a list of dashes.
 *
 * `now` comes from the caller: both screens already tick a clock for their own
 * reasons, and a third interval in here would be the same second re-derived.
 */
export function BookingFacts({ booking, now }: { booking: BookingRow; now: number }) {
  const { t, lang } = useAdminI18n();
  const f = t.frontDesk;

  // Check-in to finish — the visit, not the technician's working time. See
  // lib/booking-clock.ts for why those are deliberately different numbers.
  const { runningMs, tookMs } = serviceClock(booking, now);
  const remainingMs = runningMs === null ? null : new Date(booking.endsAt).getTime() - now;

  const row = (label: string, value: string | null | undefined): [string, string][] =>
    value ? [[label, value]] : [];

  const rows: [string, string][] = [
    [t.bookings.code, booking.code],
    ...row(f.ticket, booking.ticketNo),
    ...row(t.bookings.refillOf, booking.refillOfCode),
    [f.booked, `${localTime(booking.startsAt)} – ${localTime(booking.endsAt)}`],
    [t.bookings.service, pick(booking.serviceName, lang) || "—"],
    // High up, beside the service rather than buried under the money: on both
    // screens "who is doing it" is asked about as often as "what is it", and at
    // the desk it is said out loud along with the chair.
    [t.frontDesk.technician, booking.technicianName || t.frontDesk.unassignedShort],
    ...row(t.bookings.station, booking.stationLabel),
    [
      t.bookings.addons,
      booking.addons.length ? booking.addons.map((a) => pick(a, lang)).join("، ") : t.common.none,
    ],
    ...row(f.checkedIn, booking.checkedInAt ? localTime(booking.checkedInAt) : null),
    ...row(f.started, booking.startedAt ? localTime(booking.startedAt) : null),
    ...row(f.took, tookMs === null ? null : formatDuration(tookMs, lang)),
    // "Running for" is a lie while nobody has pressed Start — the clock counts
    // the visit, so it is already climbing for a customer sitting in reception.
    // Only the label changes: the comparison against the booked length stays,
    // because the salon measures her time from check-in however late she is
    // picked up, so that is the yardstick either way.
    ...row(
      booking.startedAt ? f.running : f.notStarted,
      runningMs === null
        ? null
        : booking.durationMin
          ? `${formatDuration(runningMs, lang)} · ${f.ofAbout(booking.durationMin)}`
          : formatDuration(runningMs, lang),
    ),
    // Only while it could still be positive — "0 minutes left" on a service that
    // ran over is a worse answer than not asking.
    ...row(
      f.remaining,
      remainingMs !== null && remainingMs > 0 ? formatDuration(remainingMs, lang) : null,
    ),
    [t.bookings.source, t.bookings.sources[booking.source]],
    // Only once someone has dealt with it — an open flag lives on /admin/no-shows,
    // not buried in a panel nobody has opened.
    ...row(t.bookings.noShowNote, booking.noShowNote),
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[booking.status]}>{t.bookings.statuses[booking.status]}</Badge>
        {/* Beside the status, not only as a line in the list below: a refill is
            priced flat and repeats an earlier visit, and the desk reading "109
            SAR" for a BIAB needs the reason before the number, not six rows
            under it. Amber so it cannot be mistaken for a status. */}
        {booking.refillOfCode ? (
          <Badge tone="warning" className="gap-1 font-semibold">
            <RefreshCw className="h-3 w-3" strokeWidth={2.25} />
            {t.bookings.refillTag}
          </Badge>
        ) : null}
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
    </div>
  );
}

/** One branch's share of a party, under that branch's name. */
function PartyBranch({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink/45">{label}</p>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

/** Who, what, and her own hour — guests of one party no longer share one. */
function PartyMember({ name, service, startsAt }: { name: string; service: string; startsAt: string }) {
  return (
    <span className="min-w-0">
      <span className="block truncate text-sm font-medium text-ink">{name}</span>
      <span className="block truncate text-[11px] text-ink/50">
        {service} · {localTime(startsAt)}
      </span>
    </span>
  );
}

export default function BookingDrawer({
  booking,
  partners,
  partnersElsewhere = [],
  branchName = null,
  canSetStatus,
  canReschedule,
  canDelete,
  checkinEarlyMin,
  branchId,
  onClose,
  onChanged,
  onOpenPartner,
}: {
  booking: BookingRow | null;
  /**
   * The rest of this booking's party, if it has one.
   *
   * Passed in rather than fetched: the screen already holds the whole day, and
   * the desk opening a drawer should not wait on a round trip to be told the
   * customer standing in front of her came with somebody.
   */
  partners: BookingRow[];
  /**
   * Members of the same party booked at another branch (./partners.ts).
   *
   * Named, not opened. This drawer's reschedule picker works against the branch
   * on screen, so opening her here would offer to move her into chairs at a
   * salon she is not booked at. Where she sits and when is what the desk needs.
   */
  partnersElsewhere?: PartnerElsewhere[];
  /** The branch on screen, to head the partners seated here. */
  branchName?: Localized | null;
  /** `bookings.delete` — CEO and admin. The action refuses anything paid for. */
  canDelete: boolean;
  /**
   * `bookings.status` — the owner only. Not the same as being allowed to work
   * the desk: check-in and closing a ticket have their own buttons on the front
   * desk and their own capability. These are the corrections to the record.
   */
  canSetStatus: boolean;
  /** `bookings.reschedule` — the owner and the desk, never admin. */
  canReschedule: boolean;
  /** `checkin_early_min`, so the drawer can count down to the unlock. */
  checkinEarlyMin: number;
  branchId: string;
  onClose: () => void;
  onChanged: () => void;
  /** Swap the drawer over to another member of the party. */
  onOpenPartner?: (b: BookingRow) => void;
}) {
  const { t, lang } = useAdminI18n();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  // The three moves that can't be walked back ask first, in the panel's own
  // dialog. A cancel also takes its (optional) reason there.
  const [asking, setAsking] = useState<"cancelled" | "no_show" | "delete" | null>(null);
  const [reason, setReason] = useState("");
  const [askError, setAskError] = useState<string | null>(null);

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

  const ask = (what: "cancelled" | "no_show" | "delete") => {
    setAsking(what);
    setReason("");
    setAskError(null);
  };

  /**
   * Erase it, after saying so out loud. The message names the group size when
   * there is one, because deleting one member takes the party with it.
   *
   * The refusals come back named, so a booking that cannot be deleted says why
   * — "cancel it instead" is a useful sentence; "failed" is not.
   */
  const remove = () => {
    if (!booking) return;
    setAskError(null);
    startTransition(async () => {
      const res = await deleteBooking(booking.id);
      if (res.ok) return onChanged();
      setAskError(
        res.error === "has-payment"
          ? t.bookings.delHasPayment
          : res.error === "has-review"
            ? t.bookings.delHasReview
            : res.error === "has-points"
              ? t.bookings.delHasPoints
              : res.error === "has-pack-credit"
                ? t.bookings.delHasPackCredit
                : t.common.error,
      );
    });
  };

  // The cancel reason is optional, but a typed one is held to the same rules as
  // every other note: letters, no mash, and a length the server keeps.
  const reasonError =
    asking === "cancelled" && reason
      ? checkNote(t.validation, t.bookings.cancelReason, reason, { required: false, max: CANCEL_REASON_MAX })
      : undefined;

  const move = (status: BookingStatus, why?: string) =>
    startTransition(async () => {
      setError(null);
      setAskError(null);
      const res = await setBookingStatus(booking.id, status, why);
      if (res.ok) return onChanged();
      const message =
        // Check-in has one refusal a person can act on — she isn't due yet — so
        // it says when, and how long that is, rather than "something went wrong".
        res.error === "too-early"
          ? // The unlock moment, not her slot — they differ whenever
            // checkin_early_min is non-zero, and saying the wrong one is worse
            // than saying nothing.
            `${t.frontDesk.tooEarly} ${localTime(new Date(opensAt).toISOString())} · ${formatCountdown(opensAt - Date.now(), lang)}`
          : t.common.error;
      if (asking) setAskError(message);
      else setError(message);
    });

  const when = formatDateTime(new Date(booking.startsAt), lang);
  const partySize = booking.groupId ? partners.length + partnersElsewhere.length + 1 : 1;

  return (
    <Drawer
      open
      onClose={onClose}
      title={booking.customerName || booking.customerPhone || booking.code}
      footer={
        <>
          {/* Alone at the reading-start edge, with the everyday buttons pushed
              away from it: the one control here that cannot be undone should
              never sit under the thumb that was reaching for Close. */}
          {canDelete ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => ask("delete")}
              disabled={pending}
              className="me-auto border-red/30 text-red hover:bg-red/[0.06]"
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
              {t.bookings.del}
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t.common.cancel}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <BookingFacts booking={booking} now={now} />

        {/* Only once the ticket is ended. Before that there is nothing to show
            and nothing to chase — the invitation is sent by setBookingStatus at
            the moment the status becomes `completed`. */}
        {booking.status === "completed" ? (
          <ReviewPanel review={booking.review ?? null} />
        ) : null}

        {canSetStatus && NEXT[booking.status].length > 0 ? (
          <div>
            <p className="mb-2 text-start text-xs font-medium text-ink/60">{t.bookings.changeStatus}</p>
            <div className="flex flex-wrap gap-2">
              {NEXT[booking.status].map((status) => (
                <button
                  key={status}
                  disabled={pending}
                  onClick={() => (status === "cancelled" || status === "no_show" ? ask(status) : move(status))}
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

        <ConfirmDialog
          open={asking === "cancelled"}
          title={t.bookings.cancelAskTitle}
          body={t.bookings.cancelAskBody(booking.code, when)}
          confirmLabel={t.bookings.cancelConfirm}
          cancelLabel={t.bookings.keepBooking}
          pending={pending}
          error={askError}
          onClose={() => setAsking(null)}
          onConfirm={() => {
            if (reasonError) return;
            move("cancelled", reason.trim() || undefined);
          }}
        >
          <TextField
            label={t.bookings.cancelReason}
            {...NOTES_TEXT}
            rows={2}
            max={CANCEL_REASON_MAX}
            error={reasonError}
            value={reason}
            onChange={setReason}
          />
        </ConfirmDialog>

        <ConfirmDialog
          open={asking === "no_show"}
          title={t.bookings.noShowAskTitle}
          body={t.bookings.noShowAskBody(booking.code, when)}
          confirmLabel={t.bookings.statuses.no_show}
          cancelLabel={t.bookings.keepBooking}
          pending={pending}
          error={askError}
          onClose={() => setAsking(null)}
          onConfirm={() => move("no_show")}
        />

        <ConfirmDialog
          open={asking === "delete"}
          title={t.bookings.delAskTitle}
          body={partySize > 1 ? t.bookings.delConfirmGroup(partySize) : t.bookings.delConfirm}
          confirmLabel={t.bookings.del}
          cancelLabel={t.bookings.keepBooking}
          pending={pending}
          error={askError}
          onClose={() => setAsking(null)}
          onConfirm={remove}
        />

        {/* The rest of the party, last: this booking's own facts and controls
            are what the drawer was opened for, and the party is where she goes
            next. One block per branch, this one first, because a guest at
            another salon is somebody this desk can see but not seat. */}
        {partners.length + partnersElsewhere.length > 0 ? (
          <div className="rounded-xl border border-sky/40 bg-sky/[0.07] p-3 text-start">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-[#2c6a88]">
              <Users className="h-3.5 w-3.5" strokeWidth={2} />
              {t.bookings.groupWith}
            </p>

            {partners.length > 0 ? (
              <PartyBranch label={t.bookings.groupHere(pick(branchName, lang))}>
                {partners.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => onOpenPartner?.(p)}
                    className="flex items-center justify-between gap-3 rounded-lg bg-white px-3 py-2 text-start transition-colors hover:bg-black/[0.03]"
                  >
                    <PartyMember name={p.customerName || p.customerPhone || p.code} service={pick(p.serviceName, lang)} startsAt={p.startsAt} />
                    <span className="flex shrink-0 items-center gap-1.5">
                      <Badge tone={STATUS_TONE[p.status]}>{t.bookings.statuses[p.status]}</Badge>
                      <ChevronRight className="h-4 w-4 text-ink/30 rtl:rotate-180" strokeWidth={2} />
                    </span>
                  </button>
                ))}
              </PartyBranch>
            ) : null}

            {[...new Set(partnersElsewhere.map((p) => pick(p.branchName, lang)))].map((name) => (
              <PartyBranch key={name} label={name}>
                {partnersElsewhere
                  .filter((p) => pick(p.branchName, lang) === name)
                  .map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center justify-between gap-3 rounded-lg bg-white/60 px-3 py-2 text-start"
                    >
                      <PartyMember name={p.customerName || p.customerPhone || p.code} service={pick(p.serviceName, lang)} startsAt={p.startsAt} />
                      <Badge tone={STATUS_TONE[p.status]}>{t.bookings.statuses[p.status]}</Badge>
                    </div>
                  ))}
              </PartyBranch>
            ))}

            <p className="mt-3 text-[11px] text-ink/50">{t.bookings.groupNote}</p>
          </div>
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
