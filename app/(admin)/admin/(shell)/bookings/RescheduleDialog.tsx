"use client";

// Moving an appointment, from the desk (brief §3.1).
//
// The server action has existed and been audited since the role screens landed,
// but nothing ever called it — docs/ADMIN-PANEL.md listed drag-to-reschedule as
// "not yet built", and so the capability governed a button that did not exist.
// This is that button.
//
// **Why not reuse the customer's ScheduleModal.** It calls useI18n(), and
// app/(admin)/layout.tsx says the site's LanguageProvider and the admin's
// AdminLangProvider "never mount together" — it would throw the moment it opened
// here. So the picker is rebuilt against the same /api/availability endpoint,
// which is the part that actually matters: the salon and the customer are asked
// the same question about the same chairs.
//
// **walkIn=1.** Staff are not held to the customer's booking lead time — the
// same exemption the walk-in drawer takes, and the same one rescheduleBooking
// already assumes ("the salon can move an appointment whenever it needs to").
// The endpoint grants it only to a signed-in staff session, so asking for it
// from here is a request, not a bypass.

import { useCallback, useEffect, useState } from "react";
import { Dialog } from "@/components/admin/overlays";
import { Button } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import { localTime, riyadhDateKey } from "@/lib/time";
import { rescheduleBooking } from "./actions";

type Slot = { time: string; startsAt: string; available: boolean };

export default function RescheduleDialog({
  open,
  booking,
  branchId,
  onClose,
  onDone,
}: {
  open: boolean;
  booking: { id: string; startsAt: string; endsAt: string } | null;
  branchId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useAdminI18n();

  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Her existing day is the sensible place to start: most moves are within it.
  useEffect(() => {
    if (!booking) return;
    setDate(riyadhDateKey(new Date(booking.startsAt)));
    setError(null);
  }, [booking]);

  // Keep the appointment exactly as long as it is. A move must not silently
  // shorten a two-hour service into whatever the grid's default happens to be.
  const durationMin = booking
    ? Math.round((new Date(booking.endsAt).getTime() - new Date(booking.startsAt).getTime()) / 60000)
    : 0;

  const load = useCallback(async () => {
    if (!booking || !branchId || !date) return;
    setSlots(null);
    try {
      const res = await fetch(
        `/api/availability?branchId=${branchId}&date=${date}&duration=${durationMin}&walkIn=1`,
      );
      const body = await res.json();
      setSlots(Array.isArray(body.slots) ? body.slots : []);
    } catch {
      setSlots([]);
      setError(t.common.error);
    }
  }, [booking, branchId, date, durationMin, t.common.error]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const move = async (startsAt: string) => {
    if (!booking) return;
    setSaving(startsAt);
    setError(null);

    const res = await rescheduleBooking({ id: booking.id, startsAt });

    if (res.ok) {
      onDone();
      onClose();
    } else {
      // "Taken" is the one a person can act on — the grid was a moment stale and
      // someone else got the chair. Reloading it is the answer, so do that for
      // them rather than leaving a dead message on screen.
      setError(res.error === "slot-taken" ? t.bookings.slotTaken : t.common.error);
      if (res.error === "slot-taken") void load();
    }
    setSaving(null);
  };

  if (!booking) return null;

  const free = (slots ?? []).filter((s) => s.available);

  return (
    <Dialog open={open} onClose={onClose} title={t.bookings.reschedule} className="max-w-xl">
      <p className="mb-4 text-start text-xs text-ink/55">
        {t.bookings.rescheduleCurrent}: <span dir="ltr">{localTime(booking.startsAt)}</span> ·{" "}
        {riyadhDateKey(new Date(booking.startsAt))}
      </p>

      <label className="block text-start">
        <span className="mb-1.5 block text-xs font-medium text-ink/60">
          {t.bookings.rescheduleOn}
        </span>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="h-11 w-full rounded-xl border border-black/10 bg-white px-3 text-sm text-ink outline-none focus:border-sky focus:ring-2 focus:ring-sky/20"
        />
      </label>

      {error ? (
        <p role="alert" className="mt-4 rounded-xl bg-red/[0.07] px-3 py-2 text-start text-sm text-red">
          {error}
        </p>
      ) : null}

      <p className="mb-2 mt-5 text-start text-xs font-medium text-ink/60">{t.bookings.pickTime}</p>

      {slots === null ? (
        // A skeleton rather than a spinner: the grid keeps its height, so the
        // times don't jump under the cursor as they arrive.
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-11 animate-pulse rounded-xl bg-black/[0.05]" />
          ))}
        </div>
      ) : free.length === 0 ? (
        <p className="rounded-xl bg-black/[0.03] px-3 py-6 text-center text-sm text-ink/50">
          {t.bookings.noSlots}
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {free.map((s) => (
            <Button
              key={s.startsAt}
              variant="secondary"
              disabled={saving !== null}
              onClick={() => void move(s.startsAt)}
              className="h-11 tabular-nums"
            >
              <span dir="ltr">{s.time}</span>
            </Button>
          ))}
        </div>
      )}
    </Dialog>
  );
}
