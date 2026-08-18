"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n";

// The cut-out in /hero-hands.webp runs off the bottom of its own canvas, so the
// forearm ends on a hard horizontal edge baked into the file. The image is
// height-locked to its container, which puts that edge partway down the hero —
// visible on tall windows, hidden on short ones, which is why it only showed up
// on some screens.
//
// Fading the last fifth of the image dissolves the arm into the cream instead of
// guillotining it. Purely presentational, and it only touches the lower forearm:
// the fingers sit around 45–60% of the image height, well above where the fade
// begins. -webkit- prefix included for Safari, which still needs it.
const FADE_BOTTOM = "linear-gradient(to bottom, #000 76%, rgba(0,0,0,0.55) 88%, transparent 99%)";
const fadeBottom = { maskImage: FADE_BOTTOM, WebkitMaskImage: FADE_BOTTOM } as const;

function CardArrow() {
  // Red capsule outline (Figma 108:4121) — narrower on mobile.
  return (
    <span className="block h-[26px] w-[70px] rounded-full border-[2px] border-red md:w-[103px]" />
  );
}

export default function Hero() {
  const { c } = useI18n();
  return (
    <>
      {/* ── Mobile hero: big centred wordmark (z-10) with the zoomed manicure
           photo overlapping it from the right (z-20) ── */}
      <section
        className="relative w-full overflow-x-clip pt-16 md:hidden"
        style={{ height: "max(430px, 90vw)" }}
      >
        {/* RED OR NUDE wordmark — big, centred */}
        <img
          src="/wordmark.svg"
          alt="RED OR NUDE"
          className="pointer-events-none absolute left-1/2 top-[58%] z-10 w-[90%] max-w-[440px] -translate-x-1/2 -translate-y-1/2 select-none min-[455px]:left-5 min-[455px]:w-[90vw] min-[455px]:max-w-none min-[455px]:translate-x-0"
        />

        {/* Manicure hands — pinned to the top; from ~455px up the width and left
            grow with the viewport so the hand gets bigger and shifts right, while
            the section height grows with it so it is never cut off at the bottom.
            Floored so smaller phones stay stable. z-20 → crosses in FRONT. */}
        <div
          aria-hidden
          className="pointer-events-none absolute z-20 aspect-[1381/993]"
          style={{ left: "max(120px, 30vw)", top: "8px", width: "max(560px, 122vw)" }}
        >
          <div className="h-full w-full" style={{ transform: "rotate(-2deg)" }}>
            <img
              src="/hero-hands.webp"
              alt=""
              style={fadeBottom}
              className="absolute right-0 top-0 h-full max-w-none select-none"
            />
          </div>
        </div>
      </section>

      {/* ── Desktop hero splash: wordmark (z-10) behind the photo (z-20) ── */}
      <section className="relative hidden h-[calc(100vh-180px)] min-h-[680px] w-full overflow-x-clip md:block">
        {/* RED OR NUDE outlined wordmark (Figma vector 108:4087) */}
        <img
          src="/wordmark.svg"
          alt="RED OR NUDE"
          className="pointer-events-none absolute z-10 w-[51%] -translate-y-1/2 select-none min-[1010px]:w-[46%]"
          style={{ left: "7%", top: "50%" }}
        />

        {/* Manicure hands photo (Figma 108:4370). FIXED px width — never
            rescales. Its left edge has a gentle vw term so that as the window
            narrows the hand drifts slowly to the left (rather than only cropping
            on the right). z-20 → fingers cross in FRONT of the wordmark. */}
        <div
          aria-hidden
          className="pointer-events-none absolute z-20 aspect-[1381/993]"
          style={{ left: "calc(390px + 19.5vw)", top: "-20px", width: "1060px" }}
        >
          <div className="h-full w-full" style={{ transform: "rotate(-1.6deg)" }}>
            <img
              src="/hero-hands.webp"
              alt=""
              style={fadeBottom}
              className="absolute right-0 top-0 h-full max-w-none select-none"
            />
          </div>
        </div>
      </section>

      {/* Three booking cards (Figma: 530×320, radius 36, gap 30) — below the fold */}
      <section className="mx-auto w-full max-w-page px-6 pb-16 pt-12 md:px-12 lg:px-16">
        <div className="grid grid-cols-1 gap-[30px] md:grid-cols-3">
          {c.hero.cards.map((card) => (
            <Link
              key={card.title}
              href={card.href}
              className="relative block rounded-card bg-white px-[8.7%] py-[9%] text-start shadow-[0_20px_50px_rgba(184,0,7,0.06)] transition-shadow hover:shadow-[0_24px_60px_rgba(184,0,7,0.12)] md:aspect-[530/320]"
            >
              <p className="font-display text-[clamp(14px,1.0vw,19px)] font-light text-ink/70">
                {card.kicker}
              </p>
              <h3 className="mt-[5%] font-display text-[clamp(24px,1.85vw,35px)] font-bold text-red">
                {card.title}
              </h3>
              <p className="mt-[6%] font-display text-[clamp(14px,1.0vw,19px)] font-light leading-relaxed text-ink/70">
                {card.desc}
              </p>
              <div className="mt-6 md:absolute md:bottom-[12%] md:left-[8.7%] md:mt-0">
                <CardArrow />
              </div>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
