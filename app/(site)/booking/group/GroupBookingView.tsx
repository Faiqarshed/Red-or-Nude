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

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Riyal } from "@/components/icons";
import { useRouter } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { useI18n } from "@/lib/i18n";
import ScheduleModal from "@/components/booking/ScheduleModal";
import BranchPicker from "@/components/booking/BranchPicker";
import Summary from "@/components/booking/Summary";
import RedoDialog, { branchRedo, guestRedo, restoredLine, type Redo } from "@/components/booking/RedoDialog";
import GuestPicker, {
  emptyGuest,
  guestFromMember,
  guestTotals,
  toMemberSelection,
  type GuestState,
} from "@/components/booking/GuestPicker";
import {
  heldTimeProblem,
  loadBooking,
  releaseHold,
  saveBooking,
  formatDateLabel,
  formatTime,
  weekdayLabel,
} from "@/lib/booking";
import { localTime, riyadhDateKey } from "@/lib/time";
import type { PublicCatalog, PublicBranch } from "@/lib/catalog";

/** The cap the client asked for. app/api/bookings/route.ts holds the same line. */
const MAX_GUESTS = 4;

/**
 * Where and when one guest sits. The day is the party's, not hers.
 *
 * `checkedMin` is how long an appointment her time was picked for: a change
 * that lands back on that length keeps it (see guestRedo).
 */
type Slot = { branchId: string | null; time: string | null; startsAt: string | null; checkedMin: number };

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

  const emptySlot = (): Slot => ({ branchId: branches[0]?.id ?? null, time: null, startsAt: null, checkedMin: 0 });

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

  /** A change that would cost a guest her time, or restored times that could not be kept. */
  const [redo, setRedo] = useState<Redo | null>(null);
  /** The slots on screen now, for the restore check that answers after she may have moved on. */
  const shownSlots = useRef(slots);
  shownSlots.current = slots;

  // Back from checkout: reopen on the party she saved there instead of two blank
  // guests. Only a group selection; a solo or station-QR one is not this page's.
  useEffect(() => {
    // Her own unpaid hold first, or it is what makes the party's times look taken.
    const letGo = releaseHold();
    const saved = loadBooking();
    const party =
      saved && saved.members.length >= 2 && saved.members.length <= MAX_GUESTS && !saved.stationToken && !saved.refillOf
        ? saved.members.map((m) => ({ m, guest: guestFromMember(catalog, m, lang) }))
        : null;
    if (!saved || !party) return;

    const restoredSlots = party.map(({ m }): Slot => {
      const branchId = m.branchId ?? saved.branchId;
      const startsAt = m.startsAt ?? saved.startsAt;
      return branchId && startsAt && branches.some((br) => br.id === branchId)
        ? { branchId, startsAt, time: localTime(startsAt), checkedMin: m.durationMin ?? 0 }
        : emptySlot();
    });
    setGuests(party.map((p) => p.guest));
    setSlots(restoredSlots);
    // Now, not on the next render: the check below can finish before that
    // render, and would read the blank guests as her having changed their times.
    shownSlots.current = restoredSlots;
    // The party's day, from whichever guest has a time: an unfinished party saves none of its own.
    const timed = restoredSlots.find((s) => s.startsAt)?.startsAt;
    if (timed) setDay(riyadhDateKey(new Date(timed)));
    setAgree(true);

    void (async () => {
      await letGo;
      const problems = await Promise.all(
        restoredSlots.map((s, i) =>
          s.branchId && s.startsAt
            ? heldTimeProblem(s.branchId, s.startsAt, guestTotals(catalog, party[i].guest).durationMin, s.checkedMin)
            : null,
        ),
      );
      // Only guests whose time is still the restored one; she may have changed some already.
      const lost = problems.flatMap((p, i) =>
        p && shownSlots.current[i]?.startsAt === restoredSlots[i].startsAt ? [{ p, i }] : [],
      );
      if (lost.length === 0) return;

      const cleared = shownSlots.current.map((s, j) => (lost.some((l) => l.i === j) ? clearTime(s) : s));
      setSlots(cleared);
      // Nobody left holding an hour on that day, so nothing holds the day either.
      if (!cleared.some((s) => s.startsAt)) setDay(null);
      setRedo({
        title: b.redoTitle.restored,
        body: `${lost
          .map(
            ({ p, i }) =>
              `${b.guestN.replace("{n}", String(i + 1))}: ${restoredLine(b, p, formatTime(restoredSlots[i].time!, c.date))}`,
          )
          .join("\n")}\n${b.redoNext}`,
        pickTime: () => {
          setOpenGuest(lost[0].i);
          setScheduling(lost[0].i);
        },
      });
    })();
    // Once, on arrival. Later renders are her own edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Her chosen hour no longer fits, or no longer exists. */
  const clearTime = (s: Slot): Slot => ({ ...s, time: null, startsAt: null });

  /**
   * Her picks changed. Only her own hour is at stake (nobody else's is touched,
   * which is the point of each guest holding her own), and she is asked first,
   * and told why, when the change costs it.
   */
  const setGuest = (i: number, next: GuestState) => {
    const slot = slots[i];
    const heldTime = slot.time ? formatTime(slot.time, c.date) : "";
    const why = guestRedo(catalog, guests[i], next, slot.checkedMin, heldTime, b, lang);
    const apply = () => {
      setGuests((prev) => prev.map((g, j) => (j === i ? next : g)));
      if (why) setSlots((prev) => prev.map((s, j) => (j === i ? clearTime(s) : s)));
    };
    if (!why || !slot.startsAt) return apply();
    setRedo({ ...why, apply, pickTime: () => setScheduling(i) });
  };

  /** A different salon has different chairs and hours, so her hour never carries. */
  const setBranch = (i: number, id: string) => {
    const slot = slots[i];
    if (id === slot.branchId) return;
    const apply = () => setSlot(i, { branchId: id, time: null, startsAt: null });
    if (!slot.startsAt) return apply();
    setRedo({
      ...branchRedo(b, slot.time ? formatTime(slot.time, c.date) : "", branchName(id) ?? ""),
      apply,
      pickTime: () => setScheduling(i),
    });
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

  /**
   * What the other guests are already holding at the branch this one is booking.
   *
   * Recomputed per open panel rather than stored, because it is a view of the
   * slots and totals above and a stored copy is one that can go stale — she
   * changes a service, her friend's duration changes, and a cached hold would
   * still be the old length.
   */
  const partyHolds = useMemo(() => {
    if (scheduling === null) return [];
    const branchId = slots[scheduling]?.branchId;
    if (!branchId) return [];
    return slots.flatMap((s, j) =>
      j !== scheduling && s.branchId === branchId && s.startsAt
        ? [{ startsAt: s.startsAt, durationMin: totals[j].durationMin }]
        : [],
    );
  }, [scheduling, slots, totals]);
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

  /**
   * Saved as they go, not only on proceed: a refresh then reopens on what is on
   * screen, not on whatever was last taken to checkout. The party's time is
   * only filled in once every guest has one, so checkout refuses an unfinished
   * party rather than posting it.
   */
  const firstRender = useRef(true);
  useEffect(() => {
    // The arrival render holds two blank guests, not her party, and in
    // StrictMode would overwrite it before the restore above has read it.
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (guests.some((g) => g.service !== null)) saveSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members]);

  const proceed = () => {
    if (!ready || !day) return;
    saveSelection();
    router.push("/booking/payment");
  };

  function saveSelection() {
    // Guest 1's branch and hour stand as the party's, and every guest carries her
    // own alongside. A group that all picked the same thing therefore posts
    // exactly the shape it always did.
    const first = slots[0];
    saveBooking({
      branchId: first.branchId,
      startsAt: slots.every((s) => s.startsAt) ? first.startsAt : null,
      // The length each time was picked for, which is what a return checks.
      members: members.map((m, i) => ({ ...m, durationMin: slots[i].checkedMin })),
      branch: branchName(first.branchId),
      dateLabel: day ? formatDateLabel(day, lang) : null,
      timeLabel: first.time ? formatTime(first.time, c.date) : null,
      checkoutAddons: catalog.checkoutAddons,
      grossTotal,
      total,
    });
  }

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
                        onChange={(id) => setBranch(i, id)}
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
          // The friends she is sitting with, which the server cannot see: none
          // of these is written down until the party pays, so /api/availability
          // answers every guest as though she were alone and offers the same
          // last chair to all four. Only the ones at her branch — a chair at Al
          // Malqa is not one she is competing for. See ScheduleModal.
          partyHolds={partyHolds}
          // Once the party has a day, there is no date left to choose: the
          // calendar is hidden and she picks an hour on it.
          onlyDate={day}
          initialDate={day}
          initialTime={slots[scheduling]!.time}
          onConfirm={(d, t, iso) => {
            setDay(d);
            setSlot(scheduling, { time: t, startsAt: iso, checkedMin: totals[scheduling].durationMin });
            setScheduling(null);
          }}
          onClose={() => setScheduling(null)}
        />
      )}

      {redo && <RedoDialog redo={redo} b={b} onClose={() => setRedo(null)} />}
    </main>
  );
}
