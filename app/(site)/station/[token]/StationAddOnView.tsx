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
import { UTC_OFFSET_HOURS } from "@/lib/time";
import type { CatalogItem } from "@/lib/catalog";
import type { Localized } from "@/lib/localized";
// Type-only, so it is erased before bundling and the `server-only` guard in
// lib/availability.ts is never actually imported into this client component.
import type { StationChoice } from "@/lib/availability";

// The scan-to-add screen (brief §2.7).
//
// The customer scanned the sticker on their own table to ask one question, so
// the page answers that question first and sells second: can I stay in this
// chair? Only once that is answered does it show anything to buy.
//
// Two shapes, decided by the server:
//   • the scanned chair is free after them — stay put, pick a service
//   • it is not — the chairs that *are* free at that moment, pick one, then a
//     service that fits it
// The second is the case the old screen dead-ended on, sending the customer off
// to /booking to start from nothing while they were still sitting in the salon.
//
// There is deliberately no ScheduleModal. The whole point of the QR is that the
// appointment is "the moment I finish", so offering a date picker would be
// offering a choice they did not come to make.
//
// Checkout is the ordinary one: this writes the same BookingSelection the
// booking page writes and hands off to /booking/payment. The only extra is
// `stationToken` — the *chosen* chair's, not necessarily the scanned one —
// which pins the booking to that chair server-side.

type Props = {
  branchId: string;
  branchName: Localized | null;
  /** The chair whose sticker was scanned, free or not. */
  scannedLabel: string;
  /** ISO UTC — the current appointment's finish, or now for an empty chair. */
  startsAt: string;
  inService: boolean;
  currentServiceName: Localized | null;
  customerName: string | null;
  /** Chairs free at `startsAt` for long enough to fit something. May be empty. */
  options: StationChoice[];
  services: (CatalogItem & { description: Localized | null })[];
  /** Empty when the chair is empty — there is no visit to bring a coffee to. */
  treats: CatalogItem[];
  /** The scanned sticker, which is the whole credential for buying a treat. */
  token: string;
};

export default function StationAddOnView({
  branchId,
  branchName,
  scannedLabel,
  startsAt,
  inService,
  currentServiceName,
  customerName,
  options,
  services,
  treats,
  token: scannedToken,
}: Props) {
  const router = useRouter();
  const { c, lang } = useI18n();
  const s = c.station;

  // The scanned chair is always first when it is on offer at all, so this is
  // "can they stay put?" without needing a second flag from the server.
  const stay = options[0]?.isCurrent ? options[0] : null;
  const alternatives = options.filter((o) => !o.isCurrent);

  const [token, setToken] = useState<string | null>(stay?.token ?? null);
  const [selected, setSelected] = useState<string | null>(null);

  const station = options.find((o) => o.token === token) ?? null;
  // Labels are what the salon writes on the sticker — usually bare numbers
  // ("2"), so every mention has to carry the noun or the page reads "2 is free
  // after you".
  const named = (label: string) => `${s.at} ${label}`;
  // Filtered here rather than on the server because the answer depends on which
  // chair is picked, and the customer can change that without a round trip.
  const fitting = station ? services.filter((x) => x.durationMin <= station.freeMin) : [];
  const service = fitting.find((x) => x.id === selected) ?? null;

  // Local wall-clock, formatted the way the rest of the site does. The customer
  // is standing in the salon: they care about "3:40", not an ISO instant. The
  // offset comes from lib/time.ts rather than a literal 3 — one place decides
  // what local means, and it is the same place the availability engine asks.
  const when = new Date(startsAt);
  const localDate = new Date(when.getTime() + UTC_OFFSET_HOURS * 3_600_000).toISOString();
  const timeLabel = formatTime(localDate.slice(11, 16), c.date);
  const dateLabel = formatDateLabel(localDate.slice(0, 10), lang);

  // Buying a coffee for the visit she is already in — a different thing from
  // booking the next appointment, and deliberately not routed through the
  // checkout. She is sitting in the chair with wet nails; a two-page flow to
  // add a drink is a flow she abandons.
  const [treatBusy, setTreatBusy] = useState<string | null>(null);
  const [treatAdded, setTreatAdded] = useState<string[]>([]);
  const [treatError, setTreatError] = useState<string | null>(null);

  const orderTreat = async (addonId: string) => {
    setTreatBusy(addonId);
    setTreatError(null);
    try {
      const res = await fetch("/api/station/treat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: scannedToken, addonId, method: "card" }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        const code = data?.error as string | undefined;
        setTreatError(
          code === "already-added"
            ? s.treatAlready
            : code === "not-in-service"
              ? s.treatNotInService
              : code === "declined"
                ? s.treatDeclined
                : s.treatFailed,
        );
        return;
      }
      setTreatAdded((prev) => [...prev, addonId]);
    } catch {
      setTreatError(s.treatFailed);
    } finally {
      setTreatBusy(null);
    }
  };

  const proceed = () => {
    if (!service || !station) return;

    saveBooking({
      branchId,
      startsAt,
      members: [
        {
          // One chair, and it belongs to whoever pays for it.
          guestName: null,
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
      // The chosen chair — this table, or the one they moved to. Resolved and
      // re-checked under a lock by POST /api/bookings.
      stationToken: station.token,
    });
    router.push("/booking/payment");
  };

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto max-w-[560px] px-6 pb-20 pt-[120px]">
        <p className="text-[11px] uppercase tracking-wider text-ink/40">
          {s.at} {scannedLabel}
          {branchName ? ` · ${pick(branchName, lang)}` : ""}
        </p>
        <h1 className="mt-1 font-display text-2xl font-extrabold text-red">{s.title}</h1>

        {/* The answer, before anything is offered for sale. Green when they can
            stay where they are, red when the chair goes to someone else — the
            one fact they scanned the sticker to find out. */}
        <div
          className={`mt-6 rounded-[20px] p-5 ${
            stay ? "bg-[#eaf5ee] ring-1 ring-[#2f7d4f]/15" : "bg-[#fbeaea]"
          }`}
        >
          <p
            className={`font-display text-lg font-extrabold ${
              stay ? "text-[#2f7d4f]" : "text-red"
            }`}
          >
            {stay
              ? s.stayTitle.replace("{table}", named(scannedLabel))
              : alternatives.length > 0
                ? s.takenTitle.replace("{table}", named(scannedLabel))
                : s.noneTitle}
          </p>

          <p className="mt-1 text-[13px] text-ink/70">
            {stay
              ? s.stayNote.replace("{n}", String(stay.freeMin))
              : alternatives.length > 0
                ? s.takenNote
                : s.noneNote}
          </p>

          {/* Why that time: their own appointment, played back so they can see
              the page is talking about their table and not the next one. */}
          <p className="mt-3 border-t border-black/[0.06] pt-3 text-[13px] text-ink/55">
            {inService ? (
              <>
                {customerName ? `${customerName} · ` : ""}
                {currentServiceName ? `${pick(currentServiceName, lang)} · ` : ""}
                {s.afterCurrent} <span className="font-semibold text-ink">{timeLabel}</span>
              </>
            ) : (
              <>
                {s.startsAt} <span className="font-semibold text-ink">{timeLabel}</span>
              </>
            )}
          </p>
        </div>

        {/* Her visit first, the next appointment second. She scanned this to
            ask about her chair; a coffee for the chair she is in is the nearer
            of the two questions and the one she can answer in one tap. */}
        {inService && treats.length > 0 && (
          <section className="mt-8">
            <p className="font-display text-base font-extrabold text-ink">{s.treatTitle}</p>
            <p className="mt-1 text-[13px] text-ink/55">{s.treatNote}</p>

            <div className="mt-4 grid gap-2">
              {treats.map((t) => {
                const added = treatAdded.includes(t.id);
                const busy = treatBusy === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => void orderTreat(t.id)}
                    disabled={added || treatBusy !== null}
                    aria-busy={busy || undefined}
                    className={`flex items-center gap-3 rounded-[16px] border p-3 text-start transition-colors ${
                      added
                        ? "border-[#2f7d4f]/30 bg-[#eaf5ee]"
                        : "border-black/[0.08] bg-white hover:border-red/30 disabled:opacity-60"
                    }`}
                  >
                    {t.img ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={t.img}
                        alt=""
                        className="h-14 w-14 shrink-0 rounded-[12px] object-cover"
                      />
                    ) : (
                      <span className="h-14 w-14 shrink-0 rounded-[12px] bg-black/[0.05]" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink">
                        {pick(t.name, lang)}
                      </span>
                      <span className="flex items-center gap-1 text-[13px] text-ink/55">
                        <Riyal className="h-3 w-3" />
                        {t.price}
                      </span>
                    </span>
                    <span className="shrink-0 text-[13px] font-semibold text-red">
                      {added ? s.treatAdded : busy ? s.treatSending : s.treatOrder}
                    </span>
                  </button>
                );
              })}
            </div>

            {treatError && (
              <p role="alert" className="mt-2 text-[12px] text-red">
                {treatError}
              </p>
            )}
          </section>
        )}

        {options.length === 0 ? (
          <Link
            href="/booking"
            className="mt-6 inline-flex rounded-full bg-red px-6 py-3 text-sm font-semibold text-white"
          >
            {s.bookElsewhere}
          </Link>
        ) : (
          <>
            {/* Only when they cannot stay put. Someone sitting in a chair that is
                free after them has no reason to be asked to choose one. */}
            {!stay && (
              <>
                <p className="mt-8 font-display text-base font-extrabold text-ink">{s.pickTable}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {alternatives.map((o) => (
                    <button
                      key={o.token}
                      type="button"
                      onClick={() => {
                        setToken(o.token);
                        // A service that fitted the last chair may not fit this
                        // one — clearing is safer than silently re-pricing.
                        setSelected(null);
                      }}
                      aria-pressed={token === o.token}
                      className={`rounded-full px-4 py-2.5 text-sm ring-1 transition-all ${
                        token === o.token
                          ? "bg-red text-white ring-red"
                          : "bg-white text-ink ring-black/[0.06] hover:ring-red/40"
                      }`}
                    >
                      <span className="font-semibold">{named(o.label)}</span>
                      <span className={token === o.token ? "text-white/70" : "text-ink/45"}>
                        {" · "}
                        {s.freeForShort.replace("{n}", String(o.freeMin))}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {station && (
              <>
                <p className="mt-8 font-display text-base font-extrabold text-ink">
                  {s.pickService}
                </p>
                <p className="mt-1 text-[12px] text-ink/45">{s.onlyFitting}</p>

                <div className="mt-4 space-y-3">
                  {fitting.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelected(item.id)}
                      aria-pressed={selected === item.id}
                      className={`flex w-full items-center justify-between rounded-[20px] bg-white p-5 text-start ring-1 transition-all ${
                        selected === item.id
                          ? "ring-2 ring-red"
                          : "ring-black/[0.04] hover:ring-red/40"
                      }`}
                    >
                      <span>
                        <span className="block font-display text-base font-extrabold text-ink">
                          {pick(item.name, lang)}
                        </span>
                        <span className="mt-0.5 block text-[12px] text-ink/45">
                          {item.durationMin} {s.minutes}
                        </span>
                      </span>
                      <span className="flex items-center gap-1 font-display text-base font-extrabold text-red">
                        {item.price}
                        <Riyal className="h-3.5 w-3.5" />
                      </span>
                    </button>
                  ))}
                </div>

                <p className="mt-6 text-[12px] text-ink/45">
                  {stay ? s.confirmWithTech : s.confirmAtTable.replace("{table}", named(station.label))}
                </p>

                <button
                  type="button"
                  onClick={proceed}
                  disabled={!service}
                  className="mt-4 w-full rounded-full bg-red px-6 py-4 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {s.proceed}
                </button>
              </>
            )}
          </>
        )}
      </div>

      <SiteFooter />
    </main>
  );
}
