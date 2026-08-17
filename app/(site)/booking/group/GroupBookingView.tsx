"use client";

// Booking for two.
//
// Two GuestPickers, one branch, one time slot. The shared slot is the whole
// point: the guests may pick completely different services (one nails, one
// lashes) and their appointments may run for different lengths, but they arrive
// together, so there is a single ScheduleModal and a single start time.
//
// The calendar is asked for two free chairs at once (guests=2) using the LONGER
// of the two durations, so a slot shown here can always be booked.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { useI18n } from "@/lib/i18n";
import ScheduleModal from "@/components/booking/ScheduleModal";
import BranchPicker from "@/components/booking/BranchPicker";
import Summary from "@/components/booking/Summary";
import GuestPicker, {
  emptyGuest,
  guestTotals,
  toMemberSelection,
  type GuestState,
} from "@/components/booking/GuestPicker";
import { saveBooking, formatDateLabel, formatTime, weekdayLabel } from "@/lib/booking";
import type { PublicCatalog, PublicBranch } from "@/lib/catalog";

export default function GroupBookingView({
  catalog,
  branchesAr,
  branchesEn,
  discountPercent,
}: {
  catalog: PublicCatalog;
  branchesAr: PublicBranch[];
  branchesEn: PublicBranch[];
  discountPercent: number;
}) {
  const router = useRouter();
  const { c, lang } = useI18n();
  const b = c.booking;
  const branches = lang === "ar" ? branchesAr : branchesEn;

  const [branchId, setBranchId] = useState<string | null>(branches[0]?.id ?? null);
  const [guests, setGuests] = useState<[GuestState, GuestState]>([emptyGuest, emptyGuest]);
  const [date, setDate] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [scheduling, setScheduling] = useState(false);

  const clearSchedule = () => {
    setDate(null);
    setTime(null);
    setStartsAt(null);
  };

  const setGuest = (i: 0 | 1, next: GuestState) => {
    setGuests((prev) => (i === 0 ? [next, prev[1]] : [prev[0], next]));
    // Either guest changing can change how long the chairs are needed.
    clearSchedule();
  };

  const totals = useMemo(() => guests.map((g) => guestTotals(catalog, g)), [catalog, guests]);
  const members = useMemo(
    () => guests.map((g) => toMemberSelection(catalog, g, lang)),
    [catalog, guests, lang],
  );

  const grossTotal = totals.reduce((sum, t) => sum + t.price, 0);
  // Mirrors splitGroupPrice on the server: one rounding, off the combined bill.
  const total = grossTotal - Math.round((grossTotal * discountPercent) / 100);

  // Both chairs are claimed for the longer appointment, so ask the calendar for
  // that. Booking then takes a strict subset of what was checked.
  const durationMin = Math.max(totals[0].durationMin, totals[1].durationMin);

  const appointment =
    date && time
      ? `${formatDateLabel(date, lang)} - ${weekdayLabel(date, c.date)} - ${formatTime(time, c.date)}`
      : b.notSelected;

  const bothChose = guests.every((g) => g.service !== null);
  const ready = bothChose && branchId !== null && startsAt !== null && agree;

  const proceed = () => {
    if (!ready || !branchId || !startsAt) return;
    saveBooking({
      branchId,
      startsAt,
      members,
      branch: branches.find((br) => br.id === branchId)?.name ?? null,
      dateLabel: date ? formatDateLabel(date, lang) : null,
      timeLabel: time ? formatTime(time, c.date) : null,
      grossTotal,
      total,
    });
    router.push("/booking/payment");
  };

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto max-w-page px-6 pt-[120px] md:px-12 lg:px-16">
        <h1 className="text-start font-display text-3xl font-extrabold text-ink">{b.groupTitle}</h1>
        <p className="mt-2 text-start text-sm text-ink/55">{b.groupSub}</p>
      </div>

      <div className="mx-auto grid max-w-page gap-8 px-6 pb-20 pt-8 md:px-12 lg:grid-cols-[1fr_360px] lg:px-16">
        <div className="space-y-10">
          <BranchPicker
            branches={branches}
            value={branchId}
            onChange={(id) => {
              setBranchId(id);
              clearSchedule();
            }}
          />

          <GuestPicker
            catalog={catalog}
            value={guests[0]}
            onChange={(next) => setGuest(0, next)}
            label={b.guest1}
            compact
          />

          <GuestPicker
            catalog={catalog}
            value={guests[1]}
            onChange={(next) => setGuest(1, next)}
            label={b.guest2}
            compact
          />

          <Link
            href="/booking"
            className="flex items-center justify-between rounded-[20px] bg-white p-5 text-start ring-1 ring-black/[0.04] transition-all hover:ring-red/40"
          >
            <span className="font-display text-base font-extrabold text-ink/70">{b.bookForOne}</span>
            <span className="text-sm text-ink/40 rtl:rotate-180">→</span>
          </Link>
        </div>

        <Summary
          members={members}
          appointment={appointment}
          onEditSchedule={() => setScheduling(true)}
          grossTotal={grossTotal}
          total={total}
          agree={agree}
          onAgree={setAgree}
          ready={ready}
          onProceed={proceed}
        />
      </div>

      <SiteFooter />

      {scheduling && branchId && (
        <ScheduleModal
          branchId={branchId}
          durationMin={durationMin}
          guests={2}
          initialDate={date}
          initialTime={time}
          onConfirm={(d, t, iso) => {
            setDate(d);
            setTime(t);
            setStartsAt(iso);
            setScheduling(false);
          }}
          onClose={() => setScheduling(false)}
        />
      )}
    </main>
  );
}
