"use client";

// Booking for a group — up to four, each with her own branch and her own hour.
//
// What they share is the day, and nothing else. The client asked for exactly
// that flexibility: four friends out together, one of whom can only make 11:00
// at Al Urubah while another takes 14:00 across town, still on one bill and
// still earning the group discount. The same-day rule is what keeps that a
// group booking rather than four bookings that happen to be on one card, and it
// is enforced again in lib/bookings.ts — this screen only refuses to submit.
//
// So there is no party-wide slot picker any more. Each guest carries her own
// branch, date and time, and the calendar is asked for ONE free chair at a time
// (guests=1) for HER duration — which is both simpler and more likely to find
// something than the old "two chairs at one moment" question.
//
// The pickers are an accordion rather than one above the other: a full service
// grid plus add-ons is a screenful each, so stacking four meant scrolling past
// everything Guest 1 chose to reach Guest 4, with no way to see at a glance
// which guests had been filled in. One open at a time, with each header
// summarising that guest, keeps the whole flow on one screen.

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

/** The cap the client asked for. app/api/bookings/route.ts holds the same line. */
const MAX_GUESTS = 4;

/** One guest's own appointment. Empty until she picks one. */
type Slot = { branchId: string | null; date: string | null; time: string | null; startsAt: string | null };

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

  const emptySlot = (): Slot => ({
    branchId: branches[0]?.id ?? null,
    date: null,
    time: null,
    startsAt: null,
  });

  // Two to start with, because that is what this page is reached for; the
  // third and fourth are added on demand.
  const [guests, setGuests] = useState<GuestState[]>([emptyGuest, emptyGuest]);
  const [slots, setSlots] = useState<Slot[]>([emptySlot(), emptySlot()]);
  const [agree, setAgree] = useState(false);
  /** Which guest's picker is expanded. Exactly one, always. */
  const [openGuest, setOpenGuest] = useState(0);
  /** Whose calendar is open, or null. */
  const [scheduling, setScheduling] = useState<number | null>(null);

  const setGuest = (i: number, next: GuestState) => {
    setGuests((prev) => prev.map((g, j) => (j === i ? next : g)));
    // Anything she changes can change how long her chair is needed, so her own
    // slot is no longer known to fit. Nobody else's is affected — that is the
    // point of each guest holding her own.
    setSlots((prev) =>
      prev.map((s, j) => (j === i ? { ...s, date: null, time: null, startsAt: null } : s)),
    );
  };

  /**
   * A guest's name, which does *not* clear her chosen time.
   *
   * Everything else in a panel changes how long her chair is needed, so setGuest
   * drops her slot and makes her pick again. A name changes nothing — and
   * routing it through setGuest would wipe the appointment on every keystroke.
   */
  const setGuestName = (i: number, name: string) =>
    setGuests((prev) => prev.map((g, j) => (j === i ? { ...g, name } : g)));

  const setSlot = (i: number, patch: Partial<Slot>) =>
    setSlots((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const addGuest = () => {
    if (guests.length >= MAX_GUESTS) return;
    setGuests((prev) => [...prev, emptyGuest]);
    setSlots((prev) => [...prev, emptySlot()]);
    setOpenGuest(guests.length);
  };

  const removeGuest = (i: number) => {
    // Two is a group; one is the other page.
    if (guests.length <= 2) return;
    setGuests((prev) => prev.filter((_, j) => j !== i));
    setSlots((prev) => prev.filter((_, j) => j !== i));
    setOpenGuest((open) => (open >= i && open > 0 ? open - 1 : open));
  };

  const totals = useMemo(() => guests.map((g) => guestTotals(catalog, g)), [catalog, guests]);
  const members = useMemo(
    () => guests.map((g) => toMemberSelection(catalog, g, lang)),
    [catalog, guests, lang],
  );

  const grossTotal = totals.reduce((sum, t) => sum + t.price, 0);
  // Mirrors splitGroupPrice on the server: one rounding, off the combined bill.
  const total = grossTotal - Math.round((grossTotal * discountPercent) / 100);

  const chosenDays = slots.map((s) => s.date).filter(Boolean) as string[];
  // The one thing the party holds in common. Refused by the server too, so this
  // is a courtesy rather than the rule itself.
  const oneDay = chosenDays.length > 0 && chosenDays.every((d) => d === chosenDays[0]);

  const allChose = guests.every((g) => g.service !== null);
  const allScheduled = slots.every((s) => s.startsAt !== null && s.branchId !== null);
  const ready = allChose && allScheduled && oneDay && agree;

  const branchName = (id: string | null) => branches.find((br) => br.id === id)?.name ?? null;

  const slotLabel = (s: Slot) =>
    s.date && s.time
      ? `${formatDateLabel(s.date, lang)} - ${weekdayLabel(s.date, c.date)} - ${formatTime(s.time, c.date)}`
      : b.notSelected;

  const proceed = () => {
    if (!ready) return;
    // Guest 1's branch and hour stand as the party's, and every guest carries
    // her own alongside. A group that all picked the same thing therefore posts
    // exactly the shape it always did.
    const first = slots[0];
    if (!first.branchId || !first.startsAt) return;

    saveBooking({
      branchId: first.branchId,
      startsAt: first.startsAt,
      members: members.map((m, i) => ({
        ...m,
        branchId: slots[i].branchId,
        startsAt: slots[i].startsAt,
        branch: branchName(slots[i].branchId),
        dateLabel: slots[i].date ? formatDateLabel(slots[i].date!, lang) : null,
        timeLabel: slots[i].time ? formatTime(slots[i].time!, c.date) : null,
      })),
      branch: branchName(first.branchId),
      dateLabel: first.date ? formatDateLabel(first.date, lang) : null,
      timeLabel: first.time ? formatTime(first.time, c.date) : null,
      checkoutAddons: catalog.checkoutAddons,
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
          <div className="space-y-4">
            {guests.map((guest, i) => (
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
                    className={`shrink-0 rounded-full px-4 py-1.5 font-display text-sm font-extrabold ${
                      openGuest === i ? "bg-red text-white" : "bg-[#f7e8e8] text-red"
                    }`}
                  >
                    {b.guestN.replace("{n}", String(i + 1))}
                  </span>

                  {/* What this guest has picked, so a collapsed panel still says
                      whether it needs attention. Her time is here rather than in
                      the summary, because it is hers and not the party's. */}
                  <span className="min-w-0 flex-1 truncate text-sm text-ink/60">
                    {members[i].service ?? b.notSelected}
                    {slots[i].time ? ` · ${formatTime(slots[i].time!, c.date)}` : ""}
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
                    {/* Asked of everyone but the first. She is whoever fills in
                        checkout, so her name is already on its way and a second
                        field for it would be the form asking a question it knows
                        the answer to.

                        Optional on purpose: a friend's name is a courtesy to the
                        desk, not something worth blocking a booking over. Left
                        empty, the chair reads as the booker's. */}
                    {i > 0 && (
                      <label className="mb-6 block">
                        <span className="mb-1.5 block text-[13px] font-semibold text-ink">
                          {b.guest2Name}
                        </span>
                        <input
                          type="text"
                          maxLength={120}
                          value={guest.name ?? ""}
                          onChange={(e) => setGuestName(i, e.target.value)}
                          autoComplete="off"
                          className="w-full rounded-[12px] border border-black/[0.12] bg-white px-4 py-3 text-sm text-ink outline-none transition-colors placeholder:text-ink/30 focus:border-red/50"
                        />
                        <span className="mt-1.5 block text-[11px] text-ink/45">
                          {b.guest2NameHint}
                        </span>
                      </label>
                    )}

                    <GuestPicker
                      catalog={catalog}
                      value={guest}
                      onChange={(next) => setGuest(i, next)}
                    />

                    {/* Her own branch and her own hour, at the bottom of her own
                        panel — after the services, because the calendar is asked
                        for the duration those services add up to. */}
                    <div className="mt-8 space-y-4 border-t border-black/[0.05] pt-6">
                      <BranchPicker
                        branches={branches}
                        value={slots[i].branchId}
                        onChange={(id) =>
                          // A different salon has different chairs and different
                          // hours, so whatever she picked here no longer holds.
                          setSlot(i, { branchId: id, date: null, time: null, startsAt: null })
                        }
                      />

                      <button
                        type="button"
                        onClick={() => setScheduling(i)}
                        disabled={!slots[i].branchId}
                        className="w-full rounded-[14px] bg-cream/70 p-4 text-start ring-1 ring-black/[0.04] transition-colors hover:ring-red/40 disabled:opacity-50"
                      >
                        <p className="mb-1 text-[11px] text-ink/45">{b.guestTime}</p>
                        <p className="text-sm font-semibold text-ink">{slotLabel(slots[i])}</p>
                      </button>
                    </div>

                    <div className="mt-6 flex gap-3">
                      {guests.length > 2 && (
                        <button
                          type="button"
                          onClick={() => removeGuest(i)}
                          className="rounded-[12px] bg-black/[0.04] px-5 py-3.5 text-sm font-bold text-ink/60 transition-colors hover:bg-black/[0.08]"
                        >
                          {b.removeGuest}
                        </button>
                      )}
                      {i < guests.length - 1 && (
                        <button
                          type="button"
                          onClick={() => setOpenGuest(i + 1)}
                          className="flex-1 rounded-[12px] bg-red-grad py-3.5 text-sm font-bold text-white transition-opacity hover:opacity-90"
                        >
                          {b.nextGuest}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </section>
            ))}
          </div>

          {guests.length < MAX_GUESTS && (
            <button
              type="button"
              onClick={addGuest}
              className="w-full rounded-[20px] border border-dashed border-red/30 bg-white/60 p-5 text-center font-display text-base font-extrabold text-red transition-colors hover:bg-white"
            >
              + {b.addGuest}
            </button>
          )}

          <Link
            href="/booking"
            className="flex items-center justify-between rounded-[20px] bg-white p-5 text-start ring-1 ring-black/[0.04] transition-all hover:ring-red/40"
          >
            <span className="font-display text-base font-extrabold text-ink/70">{b.bookForOne}</span>
            <span className="text-sm text-ink/40 rtl:rotate-180">→</span>
          </Link>
        </div>

        <div className="space-y-3">
          <Summary
            members={members}
            appointment={
              // The party's line is the day, since that is the only thing they
              // all share. Each guest's own time sits in her panel header.
              chosenDays.length && oneDay
                ? `${formatDateLabel(chosenDays[0], lang)} - ${weekdayLabel(chosenDays[0], c.date)}`
                : b.notSelected
            }
            onEditSchedule={() => setScheduling(openGuest)}
            grossTotal={grossTotal}
            total={total}
            agree={agree}
            onAgree={setAgree}
            ready={ready}
            onProceed={proceed}
          />

          {/* Only once she has actually made them disagree — a rule stated
              before it can be broken is noise. */}
          {chosenDays.length > 1 && !oneDay && (
            <p role="alert" className="rounded-[14px] bg-red/[0.08] px-4 py-3 text-start text-[12px] text-red">
              {b.sameDayNote}
            </p>
          )}
        </div>
      </div>

      <SiteFooter />

      {scheduling !== null && slots[scheduling]?.branchId && (
        <ScheduleModal
          branchId={slots[scheduling]!.branchId!}
          durationMin={totals[scheduling].durationMin}
          // One chair, hers. The party is no longer seated in one row, so asking
          // for four free at once would refuse slots that are perfectly bookable.
          guests={1}
          // Opens on the day the group has already settled on, so the common
          // case is one tap on a time rather than finding the day again.
          initialDate={slots[scheduling]!.date ?? chosenDays[0] ?? null}
          initialTime={slots[scheduling]!.time}
          onConfirm={(d, t, iso) => {
            setSlot(scheduling, { date: d, time: t, startsAt: iso });
            setScheduling(null);
          }}
          onClose={() => setScheduling(null)}
        />
      )}
    </main>
  );
}
