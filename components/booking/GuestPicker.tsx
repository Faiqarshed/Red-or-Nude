"use client";

// One guest's half of a booking: the service grid, the add-ons, the removal
// choice and the seasonal design pop-up.
//
// Extracted from BookingView so /booking renders it once and /booking/group
// renders it twice. Everything that differs between one guest and two lives in
// the parent — the branch, the time slot and the bill are shared, this is not.
//
// Controlled: the parent owns the state so it can price the whole bill and clear
// a chosen slot when a change makes it no longer fit.

import { useState } from "react";
import { Riyal } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import RemovalModal from "./RemovalModal";
import DesignsModal from "./DesignsModal";
import { pick } from "@/lib/localized";
import type { MemberSelection } from "@/lib/booking";
import type { PublicCatalog } from "@/lib/catalog";

/** Indexes into the catalogue rather than ids — the grids render by position. */
export type GuestState = {
  service: number | null;
  addons: number[];
  removal: string | null;
  design: string | null;
};

export const emptyGuest: GuestState = { service: null, addons: [], removal: null, design: null };

/** What this guest costs and how long their chair is needed. */
export function guestTotals(catalog: PublicCatalog, g: GuestState) {
  const service = g.service !== null ? catalog.services[g.service] : null;
  const removal = g.removal ? (catalog.removals.find((r) => r.id === g.removal) ?? null) : null;
  const addons = g.addons.map((i) => catalog.addons[i]);

  return {
    price: (service?.price ?? 0) + addons.reduce((s, a) => s + a.price, 0) + (removal?.price ?? 0),
    // Default 60 mirrors the old behaviour for "nothing picked yet", so the
    // calendar can still be opened before a service is chosen.
    durationMin:
      (service?.durationMin ?? 60) +
      addons.reduce((s, a) => s + a.durationMin, 0) +
      (removal?.durationMin ?? 0),
  };
}

/** Freeze the guest's choices into what the API and the summary screens need. */
export function toMemberSelection(
  catalog: PublicCatalog,
  g: GuestState,
  lang: "ar" | "en",
): MemberSelection {
  const service = g.service !== null ? catalog.services[g.service] : null;
  const removal = g.removal ? (catalog.removals.find((r) => r.id === g.removal) ?? null) : null;
  const addons = g.addons.map((i) => catalog.addons[i]);
  // The designs pop-up hands back a localised name, not an id.
  const design = g.design ? catalog.designs.find((d) => pick(d.name, lang) === g.design) : null;

  return {
    serviceId: service?.id ?? null,
    addonIds: addons.map((a) => a.id),
    removalTypeId: g.removal,
    designId: design?.id ?? null,
    service: service ? pick(service.name, lang) : null,
    addons: addons.map((a) => pick(a.name, lang)),
    removal: removal ? pick(removal.name, lang) : null,
    design: g.design,
    price: guestTotals(catalog, g).price,
  };
}

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

export default function GuestPicker({
  catalog,
  value,
  onChange,
  label,
  compact = false,
}: {
  catalog: PublicCatalog;
  value: GuestState;
  /** Any change here can alter duration, so the parent re-checks the chosen slot. */
  onChange: (next: GuestState) => void;
  /** "Guest 1" heading — omitted on the single-guest page. */
  label?: string;
  /** Tighter grids, for two pickers side by side. */
  compact?: boolean;
}) {
  const { c, lang } = useI18n();
  const b = c.booking;
  const { services, addons, removals, designs } = catalog;
  const [modal, setModal] = useState<null | "removal" | "designs">(null);

  const removalName = value.removal
    ? (removals.find((r) => r.id === value.removal)?.name ?? null)
    : null;

  const toggleAddon = (i: number) => {
    const isSeasonal = addons[i].seasonal;
    const on = value.addons.includes(i);
    if (on) {
      onChange({
        ...value,
        addons: value.addons.filter((x) => x !== i),
        design: isSeasonal ? null : value.design,
      });
      return;
    }
    onChange({ ...value, addons: [...value.addons, i] });
    // The seasonal add-on is the one that opens the designs catalogue.
    if (isSeasonal) setModal("designs");
  };

  return (
    <section className="space-y-8">
      {label && (
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-red px-4 py-1.5 font-display text-sm font-extrabold text-white">
            {label}
          </span>
          <span className="h-px flex-1 bg-black/[0.07]" />
        </div>
      )}

      <div>
        <h2 className="mb-5 text-start font-display text-2xl font-extrabold text-ink">
          {b.selectService}
        </h2>
        <div className={`grid gap-5 ${compact ? "grid-cols-2" : "grid-cols-2 md:grid-cols-4"}`}>
          {services.map((s, i) => (
            <Card
              key={s.id}
              name={pick(s.name, lang)}
              price={s.price}
              img={s.img}
              desc={pick(s.description, lang)}
              minutesLabel={`${s.durationMin} ${b.minutes.replace(/[0-9]+\s*/, "")}`.trim()}
              selected={value.service === i}
              onClick={() => onChange({ ...value, service: i })}
            />
          ))}
        </div>
      </div>

      <div>
        <h2 className="mb-5 text-start font-display text-2xl font-extrabold text-ink">
          {b.addonsTitle}
        </h2>
        <div className={`grid gap-5 ${compact ? "grid-cols-2" : "grid-cols-2 md:grid-cols-5"}`}>
          {addons.map((a, i) => (
            <Card
              key={a.id}
              name={pick(a.name, lang)}
              price={a.price}
              img={a.img}
              plus
              selected={value.addons.includes(i)}
              onClick={() => toggleAddon(i)}
            />
          ))}
        </div>
        {value.design && (
          <p className="mt-3 text-start text-[12px] text-ink/55">
            {b.chosenDesign} <span className="font-semibold text-red">{value.design}</span>
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={() => setModal("removal")}
        className="w-full rounded-[14px] bg-white p-4 text-start ring-1 ring-black/[0.04] transition-colors hover:ring-red/40"
      >
        <p className="mb-1 text-[11px] text-ink/45">{b.removal}</p>
        <p className="text-sm font-semibold text-ink">
          {removalName ? pick(removalName, lang) : b.notSelected}
        </p>
      </button>

      {modal === "removal" && (
        <RemovalModal
          removals={removals}
          initialRemoval={value.removal}
          onConfirm={(r) => {
            onChange({ ...value, removal: r });
            setModal(null);
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "designs" && (
        <DesignsModal
          designs={designs}
          initialDesign={value.design}
          onConfirm={(d) => {
            onChange({ ...value, design: d });
            setModal(null);
          }}
          onClose={() => setModal(null)}
        />
      )}
    </section>
  );
}
