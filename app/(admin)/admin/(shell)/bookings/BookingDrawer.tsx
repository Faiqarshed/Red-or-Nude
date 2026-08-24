"use client";

import { useState, useTransition } from "react";
import { Phone } from "lucide-react";
import { Badge, Button } from "@/components/admin/ui";
import { Drawer } from "@/components/admin/overlays";
import { useAdminI18n } from "@/lib/admin/i18n";
import { pick } from "@/lib/localized";
import { cn } from "@/lib/cn";
import { UTC_OFFSET_HOURS } from "@/lib/time";
import { grantRefill, setBookingStatus } from "./actions";
import { STATUS_TONE, type BookingRow, type BookingStatus } from "./BookingsView";

// Which status a booking can move to next. Cancelled/no-show are terminal —
// reopening one would silently re-reserve a chair someone else may now hold.
const NEXT: Record<BookingStatus, BookingStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["in_progress", "completed", "no_show", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  no_show: [],
};

function localTime(iso: string): string {
  return new Date(new Date(iso).getTime() + UTC_OFFSET_HOURS * 3600_000).toISOString().slice(11, 16);
}

export default function BookingDrawer({
  booking,
  canManage,
  onClose,
  onChanged,
}: {
  booking: BookingRow | null;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t, lang } = useAdminI18n();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState("30");
  const [saved, setSaved] = useState(false);

  if (!booking) return null;

  const setRefill = (value: number) =>
    startTransition(async () => {
      setError(null);
      setSaved(false);
      const res = await grantRefill({ id: booking.id, days: value });
      if (res.ok) {
        setSaved(true);
        onChanged();
      } else setError(t.common.error);
    });

  const move = (status: BookingStatus) =>
    startTransition(async () => {
      setError(null);
      const reason = status === "cancelled" ? window.prompt(t.bookings.cancelReason) ?? undefined : undefined;
      const res = await setBookingStatus(booking.id, status, reason);
      if (res.ok) onChanged();
      else setError(t.common.error);
    });

  const rows: [string, string][] = [
    [t.bookings.code, booking.code],
    ...(booking.refillOfCode
      ? ([[t.bookings.refillOf, booking.refillOfCode]] as [string, string][])
      : []),
    [t.bookings.time, `${localTime(booking.startsAt)} – ${localTime(booking.endsAt)}`],
    [t.bookings.service, pick(booking.serviceName, lang) || "—"],
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

        {/* A refill is a discount, so granting one is staff-only and audited.
            The window is a deadline counted from today, not from the
            appointment — this exists for "give her another two weeks", and that
            is what the customer means by it. Every other eligibility rule in
            refillDaysLeft() still applies on top. */}
        {canManage ? (
          <div className="rounded-xl border border-black/[0.06] bg-white p-4">
            <p className="mb-1 text-start text-xs font-medium text-ink/60">
              {t.bookings.refillGrant}
            </p>
            <p className="mb-3 text-start text-[11px] text-ink/40">
              {t.bookings.refillGrantHint}
            </p>

            {booking.refillExpiresAt ? (
              <p className="mb-3 text-start text-xs text-ink">
                {t.bookings.refillGrantedUntil}{" "}
                <span className="font-medium" dir="ltr">
                  {new Date(booking.refillExpiresAt).toISOString().slice(0, 10)}
                </span>
              </p>
            ) : null}

            <div className="flex items-center gap-2">
              <input
                value={days}
                onChange={(e) => setDays(e.target.value.replace(/\D/g, "").slice(0, 3))}
                inputMode="numeric"
                aria-label={t.bookings.refillDays}
                dir="ltr"
                className="h-10 w-20 rounded-xl border border-black/10 bg-white px-3 text-start text-sm text-ink outline-none focus:border-sky"
              />
              <Button
                size="sm"
                disabled={pending || !days || Number(days) < 1}
                onClick={() => setRefill(Number(days))}
              >
                {t.bookings.refillGrant}
              </Button>
              {booking.refillExpiresAt ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pending}
                  onClick={() => setRefill(0)}
                >
                  {t.bookings.refillRevoke}
                </Button>
              ) : null}
            </div>

            {saved ? (
              <p className="mt-2 text-start text-[11px] text-ink/50">{t.bookings.refillSaved}</p>
            ) : null}
          </div>
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
                      Pressing it is the arrival record the 20-minute no-show
                      rule measures, so it says so; the badge above still reads
                      "In progress". */}
                  {status === "in_progress" ? t.bookings.checkIn : t.bookings.statuses[status]}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-xl bg-red/[0.07] px-3 py-2 text-start text-xs text-red">
            {error}
          </p>
        ) : null}
      </div>
    </Drawer>
  );
}
