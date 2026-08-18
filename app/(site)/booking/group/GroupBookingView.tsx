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
//
// The two pickers are an accordion rather than one above the other: a full
// service grid plus add-ons is a screenful each, so stacking them meant
// scrolling past everything Guest 1 chose to reach Guest 2, with no way to see
// at a glance whether Guest 2 had been filled in at all. One open at a time,
// with each header summarising that guest, keeps the whole flow on one screen.

import { useMemo, useState } from "react";
import Link from "next/link";
import { Riyal } from "@/components/icons";
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
  /** Which guest's picker is expanded. Exactly one, always. */
  const [openGuest, setOpenGuest] = useState<0 | 1>(0);

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

          <div className="space-y-4">
            {([0, 1] as const).map((i) => (
              <section
                key={i}
                className="overflow-hidden rounded-[20px] bg-white ring-1 ring-black/[0.04]"
              >
                <button
                  type="button"
                  onClick={() => setOpenGuest(i)}
                  aria-expanded={openGuest === i}
                  className="flex w-full items-center gap-3 p-5 text-start transition-colors hover:bg-black/[0.015]"
                >
                  <span
                    className={`rounded-full px-4 py-1.5 font-display text-sm font-extrabold ${
                      openGuest === i ? "bg-red text-white" : "bg-[#f7e8e8] text-red"
                    }`}
                  >
                    {i === 0 ? b.guest1 : b.guest2}
                  </span>

                  {/* What this guest has picked, so a collapsed panel still says
                      whether it needs attention. */}
                  <span className="min-w-0 flex-1 truncate text-sm text-ink/60">
                    {members[i].service ?? b.notSelected}
                  </span>

                  {totals[i].price > 0 && (
                    <span className="flex shrink-0 items-center gap-1 font-display text-sm font-extrabold text-ink">
                      <Riyal className="h-3 w-3 text-red" />
                      {totals[i].price}
                    </span>
                  )}

                  <span
                    aria-hidden
                    className={`shrink-0 text-ink/35 transition-transform ${
                      openGuest === i ? "rotate-180" : ""
                    }`}
                  >
                    ▾
                  </span>
                </button>

                {openGuest === i && (
                  <div className="border-t border-black/[0.05] px-5 pb-6 pt-6">
                    <GuestPicker
                      catalog={catalog}
                      value={guests[i]}
                      onChange={(next) => setGuest(i, next)}
                    />

                    {/* Guest 1 has somewhere to go next; Guest 2 does not — the
                        summary beside them is the next step. */}
                    {i === 0 && (
                      <button
                        type="button"
                        onClick={() => setOpenGuest(1)}
                        className="mt-8 w-full rounded-[12px] bg-red-grad py-3.5 text-sm font-bold text-white transition-opacity hover:opacity-90"
                      >
                        {b.nextGuest}
                      </button>
                    )}
                  </div>
                )}
              </section>
            ))}
          </div>

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
