"use client";

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
  Card,
  emptyGuest,
  guestTotals,
  toMemberSelection,
  type GuestState,
} from "@/components/booking/GuestPicker";
import { saveBooking, formatDateLabel, formatTime, weekdayLabel } from "@/lib/booking";
import { pick } from "@/lib/localized";
import type { RefillOffer } from "@/lib/bookings";
import type { PublicCatalog, PublicBranch } from "@/lib/catalog";

// Figma: Desktop-2 booking flow (439:10744, …) plus the English mirror
// (276:7187 / 433:9679). One interactive page; the selection feeds
// /booking/payment, which is where the chair is actually held and paid for.
//
// The service and add-on grids live in GuestPicker, shared with /booking/group,
// so the two pages cannot drift on what a guest is allowed to pick.

export default function BookingView({
  catalog: fullCatalog,
  branchesAr,
  branchesEn,
  refill = null,
}: {
  catalog: PublicCatalog;
  branchesAr: PublicBranch[];
  branchesEn: PublicBranch[];
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
  const [agree, setAgree] = useState(false);
  const [scheduling, setScheduling] = useState(false);

  // Changing anything that alters how long the chair is needed invalidates a
  // slot that was picked for the old duration.
  const clearSchedule = () => {
    setDate(null);
    setTime(null);
    setStartsAt(null);
  };

  const { price, durationMin } = useMemo(() => guestTotals(catalog, guest), [catalog, guest]);
  const member = useMemo(
    () => toMemberSelection(catalog, guest, lang),
    [catalog, guest, lang],
  );

  const appointment =
    date && time
      ? `${formatDateLabel(date, lang)} - ${weekdayLabel(date, c.date)} - ${formatTime(time, c.date)}`
      : b.notSelected;

  const ready = guest.service !== null && branchId !== null && startsAt !== null && agree;

  const proceed = () => {
    if (!ready || !branchId || !startsAt) return;
    saveBooking({
      branchId,
      startsAt,
      members: [member],
      branch: branches.find((br) => br.id === branchId)?.name ?? null,
      dateLabel: date ? formatDateLabel(date, lang) : null,
      timeLabel: time ? formatTime(time, c.date) : null,
      grossTotal: price,
      total: price,
      refillOf: offer?.code ?? null,
    });
    router.push("/booking/payment");
  };

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto grid max-w-page gap-8 px-6 pb-20 pt-[120px] md:px-12 lg:grid-cols-[1fr_360px] lg:px-16">
        <div className="space-y-10">
          <BranchPicker
            branches={branches}
            value={branchId}
            onChange={(id) => {
              setBranchId(id);
              clearSchedule();
            }}
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
                  desc={`${c.refill.was} ${offer.fullPriceSar}`}
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
              onChange={(next) => {
                setGuest(next);
                clearSchedule();
              }}
            />
          )}

          {!offer && (
          <Link
            href="/booking/group"
            className="flex items-center justify-between rounded-[20px] bg-white p-5 text-start ring-1 ring-black/[0.04] transition-all hover:ring-red/40"
          >
            <span className="font-display text-base font-extrabold text-red">{b.bookForTwo}</span>
            <span className="text-sm text-ink/40 rtl:rotate-180">→</span>
          </Link>
          )}
        </div>

        <Summary
          members={[member]}
          appointment={appointment}
          onEditSchedule={() => setScheduling(true)}
          grossTotal={price}
          total={price}
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
            setScheduling(false);
          }}
          onClose={() => setScheduling(false)}
        />
      )}
    </main>
  );
}
