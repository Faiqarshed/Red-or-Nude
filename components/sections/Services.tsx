"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

// Figma "الخدمات" (instance 180:261). Cards expand one at a time — automatically
// cycling, and following the mouse on hover.
const serviceImgs = ["/service-1.webp", "/service-2.webp", "/service-3.webp", "/service-4.webp"];

// The RON mark over each card. Mirrored to match the design; its colour eases
// from the page background (cream) to brand red as the card enlarges.
function CardMark({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 130 96" className="h-[64px] w-[88px] -scale-x-100" fill="none">
      <path
        d="M120 14H58a34 34 0 1 0 0 68h62"
        style={{ stroke: active ? "#B80007" : "#FFFAF0", transition: "stroke 0.7s ease" }}
        strokeWidth="13"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function Services() {
  const { c, lang } = useI18n();
  const [active, setActive] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  const items = c.services.items;

  // Auto-cycle unless the user is hovering a card.
  useEffect(() => {
    if (hovered !== null) return;
    const id = setInterval(() => setActive((i) => (i + 1) % items.length), 2600);
    return () => clearInterval(id);
  }, [hovered, items.length]);

  const current = hovered ?? active;
  // Label sits in the reading-start bottom corner (right in AR, left in EN).
  const labelPos = lang === "ar" ? "right-5 text-right" : "left-5 text-left";
  const labelPosLg = lang === "ar" ? "right-8 text-right" : "left-8 text-left";

  return (
    <section id="services" className="bg-cream">
      <div className="mx-auto max-w-page px-6 py-16 md:px-12 lg:px-16">
        <h2 className="mb-10 text-start font-display text-[clamp(32px,3.4vw,48px)] font-extrabold text-ink">
          {c.services.title}
        </h2>

        {/* Mobile: simple 2-column grid of cards */}
        <div className="grid grid-cols-2 gap-4 lg:hidden">
          {items.map((name, i) => (
            <div
              key={name}
              className="relative aspect-[3/5.2] overflow-hidden rounded-[28px] bg-[#6b6b6b] bg-cover bg-center"
              style={{ backgroundImage: `url(${serviceImgs[i]})` }}
            >
              <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/55 to-transparent" />
              <div className="absolute left-0 top-1/2 origin-left -translate-y-1/2 scale-[0.62]">
                <CardMark active />
              </div>
              <div className={`absolute bottom-5 ${labelPos}`}>
                <p className="font-display text-[13px] font-light tracking-[0.25em] text-white/90">
                  {c.services.kicker}
                </p>
                <p className="font-display text-[22px] font-extrabold leading-tight text-white">
                  {name}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Desktop: cards that expand one at a time (auto-cycle + hover) */}
        <div dir="ltr" className="hidden h-[clamp(300px,33vw,460px)] gap-5 lg:flex">
          {items.map((name, i) => {
            const isActive = i === current;
            return (
              <div
                key={name}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                className="relative overflow-hidden rounded-[36px] bg-[#6b6b6b] bg-cover bg-center transition-[flex-grow] duration-500 ease-out"
                style={{ flexGrow: isActive ? 2.6 : 1, flexBasis: 0, backgroundImage: `url(${serviceImgs[i]})` }}
              >
                {/* dark scrim so the label reads on any photo */}
                <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/55 to-transparent" />

                {/* RON mark, vertically centred toward the left edge */}
                <div className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/3">
                  <CardMark active={isActive} />
                </div>

                {/* Label bottom, reading-start corner */}
                <div className={`absolute bottom-8 ${labelPosLg}`}>
                  <p className="font-display text-[clamp(16px,1.6vw,22px)] font-light tracking-[0.3em] text-white/90">
                    {c.services.kicker}
                  </p>
                  <p className="font-display text-[clamp(24px,2.8vw,44px)] font-extrabold leading-tight text-white">
                    {name}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
