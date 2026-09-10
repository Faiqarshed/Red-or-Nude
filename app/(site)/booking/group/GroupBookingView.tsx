"use client";

// Booking for a group — up to four, each with her own branch and her own hour.
//
// One day, and nothing else, is shared. The client asked for exactly that
// flexibility: four friends out together, one of whom can only make 11:00 at Al
// Urubah while another takes 14:00 across town, still on one bill and still
// earning the group discount.
//
// The day is therefore held HERE, at the party, not on each guest. It is set by
// whoever books her time first, and after that every other guest's picker opens
// on that day with no calendar in it — she is choosing an hour, not a date. That
// is the difference between a rule the screen enforces and a rule it merely
// checks: nobody can pick a second day and be told off for it afterwards.
// lib/bookings.ts still refuses a mismatched party, because a screen is not a
// guarantee.
//
// The pickers are an accordion — a full service grid plus add-ons is a
// screenful each, and stacking four means scrolling past everything Guest 1
// chose to reach Guest 4. What makes four legible rather than two is the strip
// above them: every guest, her state and her price, on one row, always visible,
// with the open one marked. The accordion is the workspace; the strip is the map.

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

/** Where and when one guest sits. The day is the party's, not hers. */
type Slot = { branchId: string | null; time: string | null; startsAt: string | null };

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

  const emptySlot = (): Slot => ({ branchId: branches[0]?.id ?? null, time: null, startsAt: null });

  // Two to start with, because that is what this page is reached for; the third
  // and fourth are added on demand.
  const [guests, setGuests] = useState<GuestState[]>([emptyGuest, emptyGuest]);
  const [slots, setSlots] = useState<Slot[]>([emptySlot(), emptySlot()]);
  /** The party's day. Whoever books first sets it; the rest inherit it. */
  const [day, setDay] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  /** Which guest's picker is expanded. Exactly one, always. */
  const [openGuest, setOpenGuest] = useState(0);
  /** Whose calendar is open, or null. */
  const [scheduling, setScheduling] = useState<number | null>(null);

  /** Her chosen hour no longer fits, or no longer exists. */
  const clearTime = (s: Slot): Slot => ({ ...s, time: null, startsAt: null });

  const setGuest = (i: number, next: GuestState) => {
    setGuests((prev) => prev.map((g, j) => (j === i ? next : g)));
    // Anything she changes can change how long her chair is needed, so her own
    // hour is no longer known to fit. Nobody else's is touched — that is the
    // point of each guest holding her own.
    setSlots((prev) => prev.map((s, j) => (j === i ? clearTime(s) : s)));
  };

  /**
   * A guest's name, which does *not* clear her chosen time.
   *
   * Everything else in a panel changes how long her chair is needed, so setGuest
   * drops her hour and makes her pick again. A name changes nothing — and
   * routing it through setGuest would wipe the appointment on every keystroke.
   */
  const setGuestName = (i: number, name: string) =>
    setGuests((prev) => prev.map((g, j) => (j === i ? { ...g, name } : g)));

  const setSlot = (i: number, patch: Partial<Slot>) =>
    setSlots((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  /** A new day invalidates every hour on the old one, so it takes them all. */
  const changeDay = () => {
    setDay(null);
    setSlots((prev) => prev.map(clearTime));
  };

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
  const branchName = (id: string | null) => branches.find((br) => br.id === id)?.name ?? null;

  /**
   * What gets shown AND what gets posted, built once.
   *
   * Her branch and hour are part of this rather than bolted on at proceed():
   * the summary beside the pickers has to show where each guest is sitting, and
   * a panel built from different data than the payload is a panel that can
   * disagree with the booking.
   */
  const members = useMemo(
    () =>
      guests.map((g, i) => ({
        ...toMemberSelection(catalog, g, lang),
        branchId: slots[i].branchId,
        startsAt: slots[i].startsAt,
        branch: branchName(slots[i].branchId),
        dateLabel: day ? formatDateLabel(day, lang) : null,
        timeLabel: slots[i].time ? formatTime(slots[i].time, c.date) : null,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog, guests, slots, day, lang, c.date],
  );

  const grossTotal = totals.reduce((sum, t) => sum + t.price, 0);
  // Mirrors splitGroupPrice on the server: one rounding, off the combined bill.
  const total = grossTotal - Math.round((grossTotal * discountPercent) / 100);

  /** Has this guest everything she needs? Drives the strip and the headers. */
  const done = (i: number) =>
    guests[i].service !== null && slots[i].startsAt !== null && slots[i].branchId !== null;

  const ready = guests.every((_, i) => done(i)) && agree;

  const proceed = () => {
    if (!ready || !day) return;
    // Guest 1's branch and hour stand as the party's, and every guest carries her
    // own alongside. A group that all picked the same thing therefore posts
    // exactly the shape it always did.
    const first = slots[0];
    if (!first.branchId || !first.startsAt) return;

    saveBooking({
      branchId: first.branchId,
      startsAt: first.startsAt,
      members,
      branch: branchName(first.branchId),
      dateLabel: formatDateLabel(day, lang),
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
        <div className="space-y-6">
          {/* The party's day, above the guests, because it belongs to all of
              them. Reads as a fact once it is set rather than a field to fill,
              which is what it is: the first guest to pick a time decided it. */}
          <div className="flex items-center gap-4 rounded-[20px] bg-white p-5 ring-1 ring-black/[0.04]">
            <div className="min-w-0 flex-1">
              <p className="mb-1 text-start text-[11px] text-ink/45">{b.groupDay}</p>
              <p className="truncate text-start text-sm font-semibold text-ink">
                {day
                  ? `${formatDateLabel(day, lang)} · ${weekdayLabel(day, c.date)}`
                  : b.pickDayFirstGuest}
              </p>
            </div>
            {day && (
              <button
                type="button"
                onClick={changeDay}
                className="shrink-0 rounded-[12px] bg-black/[0.05] px-4 py-2.5 text-[12px] font-bold text-ink/70 transition-colors hover:bg-black/[0.09]"
              >
                {b.changeDay}
              </button>
            )}
          </div>

          {/* The map: every guest at once, so four of them are a row you can
              read rather than four drawers you have to open. */}
          <div className="flex flex-wrap gap-2">
            {guests.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setOpenGuest(i)}
                className={`flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-semibold transition-colors ${
                  openGuest === i
                    ? "bg-red text-white"
                    : done(i)
                      ? "bg-white text-ink ring-1 ring-black/[0.06] hover:ring-red/30"
                      : "bg-white text-ink/50 ring-1 ring-dashed ring-red/30 hover:text-ink"
                }`}
              >
                <span
                  aria-hidden
                  className={`grid h-4 w-4 place-items-center rounded-full text-[10px] ${
                    done(i)
                      ? openGuest === i
                        ? "bg-white/25 text-white"
                        : "bg-red/10 text-red"
                      : openGuest === i
                        ? "bg-white/25 text-white"
                        : "bg-black/[0.06] text-ink/40"
                  }`}
                >
                  {done(i) ? "✓" : i + 1}
                </span>
                {b.guestN.replace("{n}", String(i + 1))}
                {totals[i].price > 0 && (
                  <span className="opacity-70">· {totals[i].price}</span>
                )}
              </button>
            ))}

            {guests.length < MAX_GUESTS && (
              <button
                type="button"
                onClick={addGuest}
                className="rounded-full border border-dashed border-red/40 px-4 py-2 text-[13px] font-bold text-red transition-colors hover:bg-red/[0.05]"
              >
                + {b.addGuest}
              </button>
            )}
          </div>

          <div className="space-y-4">
            {guests.map((guest, i) => (
              <section
                key={i}
                className={`overflow-hidden rounded-[20px] bg-white ring-1 transition-shadow ${
                  openGuest === i ? "ring-red/25" : "ring-black/[0.04]"
                }`}
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

                  {/* Her service, her branch and her hour — everything that is
                      hers rather than the party's, so a shut panel still says
                      whether it needs attention and what it settled on. */}
                  <span className="min-w-0 flex-1 truncate text-sm text-ink/60">
                    {done(i)
                      ? [members[i].service, branchName(slots[i].branchId), slots[i].time && formatTime(slots[i].time!, c.date)]
                          .filter(Boolean)
                          .join(" · ")
                      : b.guestTodo}
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
                        desk, not something worth blocking a booking over. */}
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

                    {/* Her branch stays here, with her services: it decides
                        which chairs and which hours exist for her, so it belongs
                        next to the thing it constrains. Her hour is in the
                        summary, where all four can be read at once. */}
                    <div className="mt-8 border-t border-black/[0.05] pt-6">
                      <BranchPicker
                        branches={branches}
                        value={slots[i].branchId}
                        onChange={(id) =>
                          // A different salon has different chairs and different
                          // hours, so whatever hour she picked no longer holds.
                          setSlot(i, { branchId: id, time: null, startsAt: null })
                        }
                      />
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
          appointment={
            day ? `${formatDateLabel(day, lang)} - ${weekdayLabel(day, c.date)}` : b.notSelected
          }
          grossTotal={grossTotal}
          total={total}
          agree={agree}
          onAgree={setAgree}
          ready={ready}
          onEditMember={(i) => setScheduling(i)}
          onProceed={proceed}
        />
      </div>

      <SiteFooter />

      {scheduling !== null && slots[scheduling]?.branchId && (
        <ScheduleModal
          branchId={slots[scheduling]!.branchId!}
          durationMin={totals[scheduling].durationMin}
          // One chair, hers. The party is no longer seated in one row, so asking
          // for four free at once would refuse slots that are perfectly bookable.
          guests={1}
          // Once the party has a day, there is no date left to choose: the
          // calendar is hidden and she picks an hour on it.
          onlyDate={day}
          initialDate={day}
          initialTime={slots[scheduling]!.time}
          onConfirm={(d, t, iso) => {
            setDay(d);
            setSlot(scheduling, { time: t, startsAt: iso });
            setScheduling(null);
          }}
          onClose={() => setScheduling(null)}
        />
      )}
    </main>
  );
}
