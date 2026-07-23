"use client";

import { useState, useTransition } from "react";
import { Phone } from "lucide-react";
import { Badge, Button } from "@/components/admin/ui";
import { Drawer } from "@/components/admin/overlays";
import { useAdminI18n } from "@/lib/admin/i18n";
import { pick } from "@/lib/localized";
import { cn } from "@/lib/cn";
import { setBookingStatus } from "./actions";
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
  return new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(11, 16);
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

  if (!booking) return null;

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
    [t.bookings.time, `${localTime(booking.startsAt)} – ${localTime(booking.endsAt)}`],
    [t.bookings.service, pick(booking.serviceName, lang) || "—"],
    [
      t.bookings.addons,
      booking.addons.length ? booking.addons.map((a) => pick(a, lang)).join("، ") : t.common.none,
    ],
    [t.bookings.source, t.bookings.sources[booking.source]],
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
                  {t.bookings.statuses[status]}
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
