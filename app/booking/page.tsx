"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { Riyal } from "@/components/icons";

// Figma: Desktop-2 booking flow (nodes 439:10744, 209:278, 269:1734, …) —
// reproduced as one interactive page; selections drive the summary + total.
const serviceDesc = "SHAPING | BUFFING | CUTICLE CARE | SMOOTH GEL POLISH FINISH";

const services = [
  { name: "Acrylic", price: 280, img: "/service-nails.webp" },
  { name: "Classic Manicure", price: 90, img: "/service-nails.webp" },
  { name: "BIAB", price: 220, img: "/service-nails.webp" },
  { name: "Gel Polish", price: 150, img: "/service-nails.webp" },
];

const addons = [
  { name: "Seasonal Catalogue", price: 50, img: "/addon-catalogue.webp" },
  { name: "Chrome", price: 50, img: "/addon-chrome.webp" },
  { name: "Cat eye", price: 50, img: "/addon-art.webp" },
  { name: "French Tip", price: 50, img: "/addon-art.webp" },
  { name: "Nail Art", price: 50, img: "/addon-catalogue.webp" },
];

function Card({
  name,
  price,
  img,
  selected,
  onClick,
  minutes = true,
  plus = false,
  contain = false,
}: {
  name: string;
  price: number;
  img: string;
  selected: boolean;
  onClick: () => void;
  minutes?: boolean;
  plus?: boolean;
  contain?: boolean;
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
        className={`mb-3 h-[120px] w-full rounded-[14px] bg-[#e7d9c9] bg-center bg-no-repeat ${
          contain ? "bg-contain" : "bg-cover"
        }`}
        style={{ backgroundImage: `url(${img})` }}
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
      {minutes && <p className="mt-1 text-[10px] font-medium text-ink/50">15 MIN</p>}
      <p className="mt-1 text-[8px] leading-3 text-ink/40">{serviceDesc}</p>
    </button>
  );
}

export default function BookingPage() {
  const [service, setService] = useState<number | null>(null);
  const [chosenAddons, setChosenAddons] = useState<number[]>([]);

  const toggleAddon = (i: number) =>
    setChosenAddons((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]));

  const total = useMemo(() => {
    const s = service !== null ? services[service].price : 0;
    const a = chosenAddons.reduce((sum, i) => sum + addons[i].price, 0);
    return s + a;
  }, [service, chosenAddons]);

  const summaryRows = [
    { label: "الخدمة", value: service !== null ? services[service].name : "لم يتم الاختيار" },
    {
      label: "الإضافات",
      value: chosenAddons.length ? chosenAddons.map((i) => addons[i].name).join("، ") : "لا يوجد",
    },
    { label: "الموعد", value: "لم يتم الاختيار" },
    { label: "الزينة", value: "لم يتم الاختيار" },
  ];

  const ready = service !== null;

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto grid max-w-page gap-8 px-6 pb-20 pt-[120px] md:px-12 lg:grid-cols-[1fr_360px] lg:px-16">
        {/* Selection (right in RTL) */}
        <section className="space-y-10">
          <div>
            <h2 className="mb-5 text-right font-display text-2xl font-extrabold text-ink">
              اختيار الخدمة
            </h2>
            <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
              {services.map((s, i) => (
                <Card
                  key={s.name}
                  {...s}
                  selected={service === i}
                  onClick={() => setService(i)}
                />
              ))}
            </div>
          </div>

          <div>
            <h2 className="mb-5 text-right font-display text-2xl font-extrabold text-ink">
              الإضافات
            </h2>
            <div className="grid grid-cols-2 gap-5 md:grid-cols-5">
              {addons.map((a, i) => (
                <Card
                  key={a.name}
                  {...a}
                  minutes={false}
                  plus
                  selected={chosenAddons.includes(i)}
                  onClick={() => toggleAddon(i)}
                />
              ))}
            </div>
          </div>
        </section>

        {/* Summary (left in RTL) */}
        <aside className="h-fit rounded-[24px] bg-white p-6 text-right shadow-[0_20px_50px_rgba(184,0,7,0.06)]">
          <h2 className="mb-5 text-center font-display text-2xl font-extrabold text-ink">
            ملخص الحجز
          </h2>
          <div className="grid grid-cols-2 gap-3">
            {summaryRows.map((r) => (
              <div key={r.label} className="rounded-[14px] bg-cream/70 p-4 ring-1 ring-black/[0.04]">
                <p className="mb-1 text-[11px] text-ink/45">{r.label}</p>
                <p className="text-sm font-semibold text-ink">{r.value}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-center justify-between rounded-[14px] bg-[#fbeaea] p-4">
            <div className="flex items-center gap-1 font-display text-2xl font-extrabold text-red">
              <Riyal className="h-5 w-5" />
              {total}
            </div>
            <p className="text-xs text-ink/45">المبلغ الإجمالي</p>
          </div>

          <label className="mt-4 flex items-center justify-end gap-2 text-[12px] text-ink/60">
            أوافق على الشريعة والأحكام
            <input type="checkbox" className="h-4 w-4 accent-red" />
          </label>

          <Link
            href={ready ? "/booking/payment" : "#"}
            aria-disabled={!ready}
            className={`mt-4 block w-full rounded-[12px] py-3 text-center text-sm font-bold transition-colors ${
              ready
                ? "bg-red-grad text-white hover:opacity-90"
                : "pointer-events-none bg-black/[0.06] text-ink/40"
            }`}
          >
            إتمام الحجز
          </Link>
        </aside>
      </div>

      <SiteFooter />
    </main>
  );
}
