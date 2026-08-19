"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { Riyal } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { pick } from "@/lib/localized";
import { saveBooking, formatDateLabel, formatTime } from "@/lib/booking";
import type { CatalogItem } from "@/lib/catalog";
import type { Localized } from "@/lib/localized";

// The scan-to-add screen (brief §2.7). One decision — which service — because
// the chair and the time are already settled by where the customer is sitting.
//
// There is deliberately no ScheduleModal here. The whole point of the QR is that
// the appointment is "this table, the moment I finish", so offering a date
// picker would be offering the customer a choice they did not come to make.
//
// Checkout is the ordinary one: this writes the same BookingSelection the
// booking page writes and hands off to /booking/payment, which holds the chair,
// charges, and issues the ticket. The only extra is `stationToken`, which pins
// the booking to this chair server-side.

type Props = {
  station: { label: string; branchId: string; token: string };
  branchName: Localized | null;
  /** ISO UTC — the current appointment's finish, or now for an empty chair. */
  startsAt: string;
  freeMin: number;
  inService: boolean;
  currentServiceName: Localized | null;
  customerName: string | null;
  /** Already filtered server-side to what fits in `freeMin`. */
  services: (CatalogItem & { description: Localized | null })[];
};

export default function StationAddOnView({
  station,
  branchName,
  startsAt,
  freeMin,
  inService,
  currentServiceName,
  customerName,
  services,
}: Props) {
  const router = useRouter();
  const { c, lang } = useI18n();
  const s = c.station;

  const [selected, setSelected] = useState<number | null>(null);

  // Local wall-clock, formatted the way the rest of the site does. The customer
  // is standing in the salon: they care about "3:40", not an ISO instant.
  const when = new Date(startsAt);
  const localDate = new Date(when.getTime() + 3 * 3_600_000).toISOString();
  const timeLabel = formatTime(localDate.slice(11, 16), c.date);
  const dateLabel = formatDateLabel(localDate.slice(0, 10), lang);

  // Nothing fits — either the chair is taken straight after, or the gap is too
  // short for anything on the menu. Both are the brief's "if not free" branch,
  // and both have the same answer: book it elsewhere through the normal flow.
  const busy = freeMin <= 0 || services.length === 0;

  const proceed = () => {
    if (selected === null) return;
    const service = services[selected];

    saveBooking({
      branchId: station.branchId,
      startsAt,
      members: [
        {
          serviceId: service.id,
          addonIds: [],
          removalTypeId: null,
          designId: null,
          service: pick(service.name, lang),
          addons: [],
          removal: null,
          design: null,
          price: service.price,
        },
      ],
      branch: branchName ? pick(branchName, lang) : null,
      dateLabel,
      timeLabel,
      grossTotal: service.price,
      total: service.price,
      refillOf: null,
      // The chair. Resolved and re-checked under a lock by POST /api/bookings.
      stationToken: station.token,
    });
    router.push("/booking/payment");
  };

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto max-w-[560px] px-6 pb-20 pt-[120px]">
        <p className="text-[11px] uppercase tracking-wider text-ink/40">
          {s.at} {station.label}
          {branchName ? ` · ${pick(branchName, lang)}` : ""}
        </p>
        <h1 className="mt-1 font-display text-2xl font-extrabold text-red">{s.title}</h1>

        {/* What the salon already knows, played back — so the customer can see
            at a glance that they scanned their own table and not the next one. */}
        <div className="mt-6 rounded-[20px] bg-white p-5 ring-1 ring-black/[0.04]">
          {inService ? (
            <>
              <p className="font-display text-base font-extrabold text-ink">
                {customerName ? `${s.inService} — ${customerName}` : s.inService}
              </p>
              {currentServiceName && (
                <p className="mt-1 text-[13px] text-ink/65">{pick(currentServiceName, lang)}</p>
              )}
              <p className="mt-3 text-[13px] text-ink/65">
                {s.afterCurrent} <span className="font-semibold text-ink">{timeLabel}</span>
              </p>
            </>
          ) : (
            <p className="text-[13px] text-ink/65">
              {s.startsAt} <span className="font-semibold text-ink">{timeLabel}</span>
            </p>
          )}

          {!busy && (
            <p className="mt-1 text-[13px] text-ink/65">
              {s.freeFor.replace("{n}", String(freeMin))}
            </p>
          )}
        </div>

        {busy ? (
          <div className="mt-6 rounded-[20px] bg-[#fbeaea] p-5">
            <p className="font-display text-base font-extrabold text-red">{s.busyTitle}</p>
            <p className="mt-1 text-[13px] text-ink/65">{s.busyNote}</p>
            <Link
              href="/booking"
              className="mt-4 inline-flex rounded-full bg-red px-6 py-3 text-sm font-semibold text-white"
            >
              {s.bookElsewhere}
            </Link>
          </div>
        ) : (
          <>
            <p className="mt-8 font-display text-base font-extrabold text-ink">{s.pickService}</p>
            <p className="mt-1 text-[12px] text-ink/45">{s.onlyFitting}</p>

            <div className="mt-4 space-y-3">
              {services.map((service, i) => (
                <button
                  key={service.id}
                  type="button"
                  onClick={() => setSelected(i)}
                  aria-pressed={selected === i}
                  className={`flex w-full items-center justify-between rounded-[20px] bg-white p-5 text-start ring-1 transition-all ${
                    selected === i ? "ring-2 ring-red" : "ring-black/[0.04] hover:ring-red/40"
                  }`}
                >
                  <span>
                    <span className="block font-display text-base font-extrabold text-ink">
                      {pick(service.name, lang)}
                    </span>
                    <span className="mt-0.5 block text-[12px] text-ink/45">
                      {service.durationMin} {s.minutes}
                    </span>
                  </span>
                  <span className="flex items-center gap-1 font-display text-base font-extrabold text-red">
                    {service.price}
                    <Riyal className="h-3.5 w-3.5" />
                  </span>
                </button>
              ))}
            </div>

            <p className="mt-6 text-[12px] text-ink/45">{s.confirmWithTech}</p>

            <button
              type="button"
              onClick={proceed}
              disabled={selected === null}
              className="mt-4 w-full rounded-full bg-red px-6 py-4 text-sm font-semibold text-white disabled:opacity-40"
            >
              {s.proceed}
            </button>
          </>
        )}
      </div>

      <SiteFooter />
    </main>
  );
}
