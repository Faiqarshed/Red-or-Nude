"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { Riyal } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import ScheduleModal from "@/components/booking/ScheduleModal";
import RemovalModal from "@/components/booking/RemovalModal";
import DesignsModal from "@/components/booking/DesignsModal";
import { saveBooking, formatDateLabel, formatTime, weekdayLabel } from "@/lib/booking";
import { pick } from "@/lib/localized";
import type { PublicCatalog, PublicBranch } from "@/lib/catalog";

// Figma: Desktop-2 booking flow (439:10744, …) plus the English mirror
// (276:7187 / 433:9679). One interactive page; selections feed /booking/payment.

function Card({
  name,
  price,
  img,
  desc,
  selected,
  onClick,
  minutesLabel,
  plus = false,
}: {
  name: string;
  price: number;
  img: string | null;
  desc?: string;
  selected: boolean;
  onClick: () => void;
  minutesLabel?: string;
  plus?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center rounded-[20px] bg-white p-3 text-center transition-all ${
        selected
          ? "ring-2 ring-red shadow-[0_14px_36px_rgba(184,0,7,0.18)]"
          : "ring-1 ring-black/[0.04] shadow-[0_10px_30px_rgba(184,0,7,0.05)] hover:ring-red/40"
      }`}
    >
      <div
        className="mb-3 h-[120px] w-full rounded-[14px] bg-[#e7d9c9] bg-cover bg-center bg-no-repeat"
        style={img ? { backgroundImage: `url(${img})` } : undefined}
      />
      <span
        className={`rounded-full px-4 py-1 text-[11px] font-semibold ${
          selected ? "bg-red text-white" : "bg-[#f7e8e8] text-ink"
        }`}
      >
        {name}
      </span>
      <div className="mt-2 flex items-center justify-center gap-1 font-display text-lg font-extrabold text-ink">
        <Riyal className="h-4 w-4 text-red" />
        {price}
        {plus && <span className="text-sm">+</span>}
      </div>
      {minutesLabel && <p className="mt-1 text-[10px] font-medium text-ink/50">{minutesLabel}</p>}
      {desc ? <p className="mt-1 text-[8px] leading-3 text-ink/40">{desc}</p> : null}
    </button>
  );
}

function Cell({ label, value, onClick }: { label: string; value: string; onClick?: () => void }) {
  const base = "rounded-[14px] bg-cream/70 p-4 text-start ring-1 ring-black/[0.04]";
  const content = (
    <>
      <p className="mb-1 text-[11px] text-ink/45">{label}</p>
      <p className="text-sm font-semibold text-ink">{value}</p>
    </>
  );
  if (!onClick) return <div className={base}>{content}</div>;
  return (
    <button type="button" onClick={onClick} className={`${base} w-full transition-colors hover:ring-red/40`}>
      {content}
    </button>
  );
}

export default function BookingView({
  catalog,
  branchesAr,
  branchesEn,
}: {
  catalog: PublicCatalog;
  branchesAr: PublicBranch[];
  branchesEn: PublicBranch[];
}) {
  const router = useRouter();
  const { c, lang } = useI18n();
  const b = c.booking;
  const branches = lang === "ar" ? branchesAr : branchesEn;
  const { services, addons, removals, designs } = catalog;
  // A booking belongs to a branch — the static page never asked which one.
  const [branchId, setBranchId] = useState<string | null>(branches[0]?.id ?? null);
  const [service, setService] = useState<number | null>(null);
  const [chosenAddons, setChosenAddons] = useState<number[]>([]);
  const [removal, setRemoval] = useState<string | null>(null);
  const [design, setDesign] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [modal, setModal] = useState<null | "removal" | "schedule" | "designs">(null);

  // Changing anything that alters how long the chair is needed invalidates a
  // slot that was picked for the old duration.
  const clearSchedule = () => {
    setDate(null);
    setTime(null);
    setStartsAt(null);
  };

  const toggleAddon = (i: number) => {
    const isSeasonal = addons[i].seasonal;
    clearSchedule();
    setChosenAddons((prev) => {
      const on = prev.includes(i);
      if (on) {
        if (isSeasonal) setDesign(null);
        return prev.filter((x) => x !== i);
      }
      if (isSeasonal) setModal("designs");
      return [...prev, i];
    });
  };

  // Removal price now comes from the chosen removal type rather than one flat
  // constant, so the salon can price Gel and Builder Gel differently.
  const chosenRemoval = removal ? removals.find((r) => r.id === removal) ?? null : null;

  const total = useMemo(() => {
    const s = service !== null ? services[service].price : 0;
    const a = chosenAddons.reduce((sum, i) => sum + addons[i].price, 0);
    return s + a + (chosenRemoval?.price ?? 0);
  }, [service, chosenAddons, chosenRemoval, services, addons]);

  const removalName = chosenRemoval ? pick(chosenRemoval.name, lang) : b.notSelected;

  // How long the chair is reserved for: service + add-ons + removal. This is
  // what the availability engine needs to know a slot actually fits.
  const durationMin = useMemo(() => {
    const s = service !== null ? services[service].durationMin : 60;
    const a = chosenAddons.reduce((sum, i) => sum + addons[i].durationMin, 0);
    return s + a + (chosenRemoval?.durationMin ?? 0);
  }, [service, chosenAddons, chosenRemoval, services, addons]);

  const appointment =
    date && time
      ? `${formatDateLabel(date, lang)} - ${weekdayLabel(date, c.date)} - ${formatTime(time, c.date)}`
      : b.notSelected;

  const ready = service !== null && branchId !== null && startsAt !== null && agree;

  const proceed = () => {
    if (!ready || service === null || !branchId || !startsAt) return;
    const chosenDesign = design ? designs.find((d) => pick(d.name, lang) === design) : null;
    saveBooking({
      branchId,
      serviceId: services[service].id,
      addonIds: chosenAddons.map((i) => addons[i].id),
      removalTypeId: removal,
      designId: chosenDesign?.id ?? null,
      startsAt,
      service: pick(services[service].name, lang),
      addons: chosenAddons.map((i) => pick(addons[i].name, lang)),
      removal: chosenRemoval ? pick(chosenRemoval.name, lang) : null,
      design,
      branch: branches.find((br) => br.id === branchId)?.name ?? null,
      dateLabel: date ? formatDateLabel(date, lang) : null,
      timeLabel: time ? formatTime(time, c.date) : null,
      total,
    });
    router.push("/booking/payment");
  };

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto grid max-w-page gap-8 px-6 pb-20 pt-[120px] md:px-12 lg:grid-cols-[1fr_360px] lg:px-16">
        {/* Selection */}
        <section className="space-y-10">
          {branches.length > 1 && (
            <div>
              <h2 className="mb-5 text-start font-display text-2xl font-extrabold text-ink">
                {c.modals.branchTitle}
              </h2>
              <div className="flex flex-wrap gap-3">
                {branches.map((br) => (
                  <button
                    key={br.id}
                    type="button"
                    onClick={() => {
                      setBranchId(br.id);
                      clearSchedule();
                    }}
                    className={`rounded-[14px] px-5 py-3 text-sm transition-all ${
                      branchId === br.id
                        ? "bg-red font-bold text-white shadow-[0_8px_20px_rgba(184,0,7,0.2)]"
                        : "bg-white text-ink ring-1 ring-black/[0.06] hover:ring-red/40"
                    }`}
                  >
                    {br.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <h2 className="mb-5 text-start font-display text-2xl font-extrabold text-ink">
              {b.selectService}
            </h2>
            <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
              {services.map((s, i) => (
                <Card
                  key={s.id}
                  name={pick(s.name, lang)}
                  price={s.price}
                  img={s.img}
                  desc={pick(s.description, lang)}
                  minutesLabel={`${s.durationMin} ${b.minutes.replace(/[0-9]+\s*/, "")}`.trim()}
                  selected={service === i}
                  onClick={() => {
                    setService(i);
                    clearSchedule();
                  }}
                />
              ))}
            </div>
          </div>

          <div>
            <h2 className="mb-5 text-start font-display text-2xl font-extrabold text-ink">
              {b.addonsTitle}
            </h2>
            <div className="grid grid-cols-2 gap-5 md:grid-cols-5">
              {addons.map((a, i) => (
                <Card
                  key={a.id}
                  name={pick(a.name, lang)}
                  price={a.price}
                  img={a.img}
                  plus
                  selected={chosenAddons.includes(i)}
                  onClick={() => toggleAddon(i)}
                />
              ))}
            </div>
            {design && (
              <p className="mt-3 text-start text-[12px] text-ink/55">
                {b.chosenDesign} <span className="font-semibold text-red">{design}</span>
              </p>
            )}
          </div>
        </section>

        {/* Summary */}
        <aside className="h-fit rounded-[24px] bg-white p-6 text-start shadow-[0_20px_50px_rgba(184,0,7,0.06)]">
          <h2 className="mb-5 text-center font-display text-2xl font-extrabold text-ink">
            {b.summaryTitle}
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <Cell
              label={b.service}
              value={service !== null ? pick(services[service].name, lang) : b.notSelected}
            />
            <Cell
              label={b.addons}
              value={
                chosenAddons.length
                  ? chosenAddons.map((i) => pick(addons[i].name, lang)).join("، ")
                  : b.none
              }
            />
            <Cell label={b.removal} value={removalName} onClick={() => setModal("removal")} />
            <Cell label={b.appointment} value={appointment} onClick={() => setModal("schedule")} />
          </div>

          <div className="mt-4 flex items-center justify-between rounded-[14px] bg-[#fbeaea] p-4">
            <div className="flex items-center gap-1 font-display text-2xl font-extrabold text-red">
              <Riyal className="h-5 w-5" />
              {total}
            </div>
            <p className="text-xs text-ink/45">{b.total}</p>
          </div>

          <label className="mt-4 flex items-center justify-end gap-2 text-[12px] text-ink/60">
            {b.agree}
            <input
              type="checkbox"
              checked={agree}
              onChange={(e) => setAgree(e.target.checked)}
              className="h-4 w-4 accent-red"
            />
          </label>

          <button
            type="button"
            onClick={proceed}
            disabled={!ready}
            className={`mt-4 block w-full rounded-[12px] py-3 text-center text-sm font-bold transition-colors ${
              ready
                ? "bg-red-grad text-white hover:opacity-90"
                : "cursor-not-allowed bg-black/[0.06] text-ink/40"
            }`}
          >
            {b.complete}
          </button>
        </aside>
      </div>

      <SiteFooter />

      {modal === "removal" && (
        <RemovalModal
          removals={removals}
          initialRemoval={removal}
          onConfirm={(r) => {
            setRemoval(r);
            clearSchedule();
            setModal(null);
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "schedule" && (
        <ScheduleModal
          branchId={branchId!}
          durationMin={durationMin}
          initialDate={date}
          initialTime={time}
          onConfirm={(d, t, iso) => {
            setDate(d);
            setTime(t);
            setStartsAt(iso);
            setModal(null);
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "designs" && (
        <DesignsModal
          designs={designs}
          initialDesign={design}
          onConfirm={(d) => {
            setDesign(d);
            setModal(null);
          }}
          onClose={() => setModal(null)}
        />
      )}
    </main>
  );
}
