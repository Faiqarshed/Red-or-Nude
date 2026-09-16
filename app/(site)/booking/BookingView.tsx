"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { useI18n } from "@/lib/i18n";
import ScheduleModal from "@/components/booking/ScheduleModal";
import RedoDialog, { branchRedo, guestRedo, restoredLine, type Redo } from "@/components/booking/RedoDialog";
import BranchPicker from "@/components/booking/BranchPicker";
import Summary from "@/components/booking/Summary";
import GuestPicker, {
  Card,
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
import { pick } from "@/lib/localized";
import type { RefillOffer } from "@/lib/bookings";
import type { PublicCatalog, PublicBranch } from "@/lib/catalog";
import type { Localized } from "@/lib/localized";

// Figma: Desktop-2 booking flow (439:10744, …) plus the English mirror
// (276:7187 / 433:9679). One interactive page; the selection feeds
// /booking/payment, which is where the chair is actually held and paid for.
//
// The service and add-on grids live in GuestPicker, shared with /booking/group,
// so the two pages cannot drift on what a guest is allowed to pick.

/** One line of what she can spend here, from lib/packs.ts. */
export type BookableCredit = {
  customerPackId: string;
  packName: Localized;
  serviceId: string;
  left: number;
};

export default function BookingView({
  catalog: fullCatalog,
  branchesAr,
  branchesEn,
  credits = [],
  refill = null,
}: {
  catalog: PublicCatalog;
  branchesAr: PublicBranch[];
  branchesEn: PublicBranch[];
  /** Pack credits she can spend. Empty for a guest, and for a service she has none for. */
  credits?: BookableCredit[];
  /** Set when the customer arrived from the refill button in their history. */
  refill?: RefillOffer | null;
}) {
  const router = useRouter();
  const { c, lang } = useI18n();
  const b = c.booking;
  const branches = lang === "ar" ? branchesAr : branchesEn;

  // A refill is the same page with the catalogue narrowed to one service at its
  // reduced price. Narrowing the data rather than special-casing the UI means
  // pricing, the summary and the slot picker all keep working untouched — and
  // the customer physically cannot swap the service, which is the rule.
  const { catalog, offer, prefilled } = useMemo(() => {
    const service = refill && fullCatalog.services.find((s) => s.id === refill.serviceId);
    // The salon deactivated the service since — fall back to a normal booking
    // rather than offering something that can no longer be booked.
    if (!refill || !service) {
      return { catalog: fullCatalog, offer: null, prefilled: emptyGuest };
    }

    // A refill repeats the original appointment, so everything it included is
    // selected up front and the customer picks nothing.
    //
    // Add-ons are matched back to the live catalogue by id: one that has since
    // been retired is dropped rather than carried, because it can no longer be
    // booked or priced. That means the quote here is always built from the same
    // selection that gets sent, so what is shown and what is charged agree.
    const addonIndexes = refill.addons
      .map((a) => fullCatalog.addons.findIndex((x) => x.id === a.id))
      .filter((i) => i >= 0);

    const removalId =
      refill.removal && fullCatalog.removals.some((r) => r.id === refill.removal!.id)
        ? refill.removal.id
        : null;

    return {
      catalog: { ...fullCatalog, services: [{ ...service, price: refill.priceSar }] },
      offer: refill,
      prefilled: { service: 0, addons: addonIndexes, removal: removalId, design: null },
    };
  }, [fullCatalog, refill]);

  const [branchId, setBranchId] = useState<string | null>(branches[0]?.id ?? null);
  // On a refill this is already the whole appointment; there is nothing to pick.
  const [guest, setGuest] = useState<GuestState>(prefilled);
  const [date, setDate] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [startsAt, setStartsAt] = useState<string | null>(null);
  /**
   * How long an appointment the held time was checked for. Not the current
   * length: going 90 → 60 → 90 minutes is back inside what was checked, and
   * must not ask her to pick again.
   */
  const [checkedMin, setCheckedMin] = useState(0);
  const [agree, setAgree] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  /**
   * Set only when she has actively turned a membership credit *off*.
   *
   * The default is to spend it: she bought the membership for this, and an
   * opt-in buried under the removal picker meant customers paid full price with
   * credits sitting in their account. Declining is the rarer intent, so
   * declining is what takes the click — and it is one click, in the summary,
   * beside the total it changes.
   */
  const [declinedCredit, setDeclinedCredit] = useState(false);
  /** A change that would cost her the time she picked, or a restored time that could not be kept. */
  const [redo, setRedo] = useState<Redo | null>(null);
  /** The time on screen now, for the restore check that answers after she may have moved on. */
  const shownStartsAt = useRef(startsAt);
  shownStartsAt.current = startsAt;

  // Back from checkout: reopen on what she saved there instead of a blank page.
  // Only a solo selection made on this page, for this same refill or none — a
  // group or a station-QR booking is not this screen's to resume.
  useEffect(() => {
    const saved = loadBooking();
    const m = saved?.members[0];
    const restored = m && guestFromMember(catalog, m, lang);
    const resumable =
      saved && restored && restored.service !== null && saved.members.length === 1 &&
      !saved.stationToken && (saved.refillOf ?? null) === (offer?.code ?? null);

    if (resumable) {
      setGuest(restored);
      setDeclinedCredit(!m.customerPackId);
      setAgree(true);
      if (saved.startsAt && saved.branchId && branches.some((br) => br.id === saved.branchId)) {
        setBranchId(saved.branchId);
        setDate(riyadhDateKey(new Date(saved.startsAt)));
        setTime(localTime(saved.startsAt));
        setStartsAt(saved.startsAt);
        setCheckedMin(m.durationMin ?? 0);
        // Now, not on the next render: the check below can finish before that
        // render, and would read the empty page as her having changed the time.
        shownStartsAt.current = saved.startsAt;
      }
    }

    void (async () => {
      // Her own unpaid hold first, or it is what makes her time look taken.
      await releaseHold();
      if (!resumable || !saved.startsAt || !saved.branchId || shownStartsAt.current !== saved.startsAt) return;
      const length = guestTotals(catalog, restored).durationMin;
      const problem = await heldTimeProblem(saved.branchId, saved.startsAt, length, m.durationMin);
      // She may have changed it herself while this was asking.
      if (!problem || shownStartsAt.current !== saved.startsAt) return;
      clearSchedule();
      setCheckedMin(length);
      setRedo({
        title: b.redoTitle.restored,
        body: `${restoredLine(b, problem, formatTime(localTime(saved.startsAt), c.date))} ${b.redoNext}`,
        pickTime: () => setScheduling(true),
      });
    })();
    // Once, on arrival. Later renders are her own edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearSchedule = () => {
    setDate(null);
    setTime(null);
    setStartsAt(null);
  };

  const { price: fullPrice, durationMin } = useMemo(
    () => guestTotals(catalog, guest),
    [catalog, guest],
  );

  const heldTime = time ? formatTime(time, c.date) : "";

  /** Her picker changed. Asked first, and told why, when it costs her the time. */
  const changeGuest = (next: GuestState) => {
    const why = guestRedo(catalog, guest, next, checkedMin, heldTime, b, lang);
    const apply = () => {
      setGuest(next);
      if (why) clearSchedule();
      // A different service is a different credit, so the question is asked
      // again rather than staying declined from the last one.
      setDeclinedCredit(false);
    };
    if (!why || !startsAt) return apply();
    setRedo({ ...why, apply, pickTime: () => setScheduling(true) });
  };

  const changeBranch = (id: string) => {
    if (id === branchId) return;
    const apply = () => {
      setBranchId(id);
      clearSchedule();
    };
    if (!startsAt) return apply();
    setRedo({
      ...branchRedo(b, heldTime, branches.find((br) => br.id === id)?.name ?? ""),
      apply,
      pickTime: () => setScheduling(true),
    });
  };

  const service = guest.service !== null ? catalog.services[guest.service] : null;
  // A credit is for one service. Offered only once she has picked the service it
  // is for — before that there is nothing to spend it on.
  //
  // Not offered on a refill: that line is already 99, and two discounts on one
  // line is a question nobody has answered. priceMember refuses it server-side
  // for the same reason.
  const credit = offer || !service ? null : credits.find((c) => c.serviceId === service.id) ?? null;
  const spending = credit && !declinedCredit ? credit : null;

  // The credit pays for the service and nothing else — add-ons, a removal and a
  // coffee are the same work either way. Mirrors priceMember exactly.
  const price = spending && service ? fullPrice - service.price : fullPrice;

  const member = useMemo(
    () => toMemberSelection(catalog, guest, lang),
    [catalog, guest, lang],
  );

  const appointment =
    date && time
      ? `${formatDateLabel(date, lang)} - ${weekdayLabel(date, c.date)} - ${formatTime(time, c.date)}`
      : b.notSelected;

  const ready = guest.service !== null && branchId !== null && startsAt !== null && agree;

  /**
   * Saved as she goes, not only on proceed: a refresh then reopens on what is on
   * screen, not on whatever she last took to checkout. Checkout refuses a
   * selection without a service or a time, so an unfinished one is safe to keep.
   */
  const firstRender = useRef(true);
  useEffect(() => {
    // The arrival render holds the page's defaults, not her booking — and in
    // StrictMode would overwrite it before the restore above has read it.
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (guest.service !== null) saveSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guest, branchId, startsAt, checkedMin, declinedCredit, lang]);

  const proceed = () => {
    if (!ready || !branchId || !startsAt) return;
    saveSelection();
    router.push("/booking/payment");
  };

  function saveSelection() {
    saveBooking({
      branchId,
      startsAt,
      members: [
        {
          ...member,
          // The length her time was picked for, which is what a return checks.
          durationMin: checkedMin,
          price,
          customerPackId: spending?.customerPackId ?? null,
          // What the credit took off, kept beside the reduced price so the
          // checkout can show the subtraction rather than only its result.
          creditSar: spending && service ? service.price : null,
          packName: spending ? pick(spending.packName, lang) : null,
        },
      ],
      branch: branches.find((br) => br.id === branchId)?.name ?? null,
      dateLabel: date ? formatDateLabel(date, lang) : null,
      timeLabel: time ? formatTime(time, c.date) : null,
      checkoutAddons: catalog.checkoutAddons,
      grossTotal: price,
      total: price,
      refillOf: offer?.code ?? null,
    });
  }

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto grid max-w-page gap-8 px-6 pb-20 pt-[120px] md:px-12 lg:grid-cols-[1fr_360px] lg:px-16">
        <div className="space-y-10">
          <BranchPicker
            branches={branches}
            value={branchId}
            onChange={changeBranch}
          />

          {offer ? (
            /* A refill is the same appointment again, so there is nothing to
               choose — this lists what it repeats and the customer goes
               straight to picking a time. Built from the live catalogue and the
               selection above rather than from the offer, so what is listed here
               is exactly what gets priced and charged. */
            <div className="rounded-[20px] bg-[#fbeaea] p-5 text-start">
              <p className="font-display text-base font-extrabold text-red">{c.refill.title}</p>
              <p className="mt-1 text-[13px] text-ink/65">
                {c.refill.note
                  .replace("{service}", pick(offer.serviceName, lang))
                  .replace("{n}", String(offer.daysLeft))}
              </p>

              <p className="mt-4 text-[11px] uppercase tracking-wider text-ink/40">
                {c.refill.included}
              </p>

              {/* The same cards the picker shows, without the choosing — so a
                  refill looks like the booking it repeats. */}
              <div className="mt-3 grid grid-cols-2 gap-4 md:grid-cols-4">
                <Card
                  name={pick(offer.serviceName, lang)}
                  price={offer.priceSar}
                  img={catalog.services[0]?.img ?? null}
                  // Only when the refill actually costs less. It is a flat 99
                  // now, and a service cheaper than that refills for more than
                  // it costs new — the salon is meant to keep those out of the
                  // offer, but if one slips through, printing the old price
                  // beside a higher one reads as a saving that is not there.
                  desc={
                    offer.priceSar < offer.fullPriceSar
                      ? `${c.refill.was} ${offer.fullPriceSar}`
                      : undefined
                  }
                  minutesLabel={
                    catalog.services[0]
                      ? `${catalog.services[0].durationMin} ${b.minutes.replace(/[0-9]+\s*/, "")}`.trim()
                      : undefined
                  }
                  selected
                />

                {guest.addons.map((i) => (
                  <Card
                    key={catalog.addons[i].id}
                    name={pick(catalog.addons[i].name, lang)}
                    price={catalog.addons[i].price}
                    img={catalog.addons[i].img}
                    selected
                  />
                ))}

                {guest.removal &&
                  (() => {
                    const r = catalog.removals.find((x) => x.id === guest.removal)!;
                    return <Card name={pick(r.name, lang)} price={r.price} img={r.img} selected />;
                  })()}
              </div>

              <p className="mt-4 text-[12px] text-ink/45">{c.refill.serviceOnly}</p>
            </div>
          ) : (
            <GuestPicker
              catalog={catalog}
              value={guest}
              onChange={changeGuest}
            />
          )}

          {!offer && (
          <Link
            href="/booking/group"
            className="flex items-center justify-between rounded-[20px] bg-white p-5 text-start ring-1 ring-black/[0.04] transition-all hover:ring-red/40"
          >
            <span>
              <span className="block font-display text-base font-extrabold text-red">{b.bookForTwo}</span>
              {/* Said before she leaves, to a member only. The group page has no
                  credit row at all, and finding that out after building a party
                  of four is too late to be told. */}
              {credits.length > 0 && (
                <span className="block text-[12px] text-ink/55">{c.packs.noCreditGroup}</span>
              )}
            </span>
            <span className="shrink-0 text-sm text-ink/40 rtl:rotate-180">→</span>
          </Link>
          )}

          {/* The way to the pack shelf from booking. The home page's hero card
              and the account's memberships section are the other two. It lives
              here rather than in the header because a pack is a way of
              paying for these services, not a fourth thing to do — and because
              the row above it is the same offer in a different shape.

              Shown whether or not she already has credits: the checkbox above
              only appears for a service she holds one for, so a customer halfway
              through her six would otherwise have nowhere to buy the next pack.
              Hidden on a refill, like the group row, where the appointment is
              already priced and there is nothing to choose. */}
          {!offer && (
          <Link
            href="/memberships"
            className="flex items-center justify-between rounded-[20px] bg-white p-5 text-start ring-1 ring-black/[0.04] transition-all hover:ring-red/40"
          >
            <span>
              <span className="block font-display text-base font-extrabold text-red">
                {c.packs.browse}
              </span>
              <span className="block text-[12px] text-ink/55">{c.packs.sub}</span>
            </span>
            <span className="shrink-0 text-sm text-ink/40 rtl:rotate-180">→</span>
          </Link>
          )}
        </div>

        <Summary
          members={[member]}
          appointment={appointment}
          onEditSchedule={() => setScheduling(true)}
          grossTotal={price}
          total={price}
          credit={
            credit && service
              ? {
                  label: c.packs.creditLine
                    .replace("{pack}", pick(credit.packName, lang))
                    .replace("{n}", String(credit.left)),
                  amount: service.price,
                  applied: Boolean(spending),
                  onToggle: (on) => setDeclinedCredit(!on),
                }
              : null
          }
          creditNote={
            // Only to someone holding credits, and only once a service is picked
            // — to anyone else the absence of a credit row is not a question.
            !offer && service && credits.length > 0 ? c.packs.noCreditHere : null
          }
          agree={agree}
          onAgree={setAgree}
          ready={ready}
          onProceed={proceed}
        />
      </div>

      <SiteFooter />

      {scheduling && branchId && (
        <ScheduleModal
          lastDate={offer?.lastDate ?? null}
          branchId={branchId}
          durationMin={durationMin}
          initialDate={date}
          initialTime={time}
          onConfirm={(d, t, iso) => {
            setDate(d);
            setTime(t);
            setStartsAt(iso);
            setCheckedMin(durationMin);
            setScheduling(false);
          }}
          onClose={() => setScheduling(false)}
        />
      )}

      {redo && <RedoDialog redo={redo} b={b} onClose={() => setRedo(null)} />}
    </main>
  );
}
