"use client";

import { PinIcon, ClockIcon } from "../icons";
import { useI18n } from "@/lib/i18n";

export default function BranchMap() {
  const { c, lang } = useI18n();
  const branches = c.branch.list;

  return (
    <section id="branches" className="relative z-10 lg:-mb-[9%]">
      {/* Clean map — faded to cream on the reading-start side so the heading stays
          readable (right in Arabic, left in English). */}
      <div
        className={`relative h-[70vh] min-h-[540px] w-full overflow-hidden bg-[#f3eee6] bg-no-repeat [background-size:auto_105%] lg:h-screen lg:min-h-[680px] lg:[background-position:center_40%] lg:[background-size:150%_auto] ${
          lang === "ar" ? "[background-position:64%_center]" : "[background-position:36%_center]"
        }`}
        style={{ backgroundImage: "url(/map-riyadh.webp)" }}
      >
        {/* Cream fade behind the heading */}
        <div
          className={`pointer-events-none absolute inset-y-0 start-0 w-[58%] from-cream via-cream/80 to-transparent lg:w-[70%] lg:via-cream/80 ${
            lang === "ar" ? "bg-gradient-to-l" : "bg-gradient-to-r"
          }`}
        />

        {/* Heading + booking CTA — vertically centred on the reading-start side */}
        <div className="absolute inset-y-0 start-0 flex flex-col justify-center gap-5 px-6 text-start md:px-16 lg:gap-8 lg:px-24">
          {lang === "ar" ? (
            <>
              <h2 className="font-display text-[clamp(34px,5.3vw,66px)] font-thin leading-[1.5] text-ink">
                <span className="block pr-[0.6em]">{c.branch.line1}</span>
                <span className="block">{c.branch.line2}</span>
              </h2>
              <button className="w-fit self-end rounded-[100px] border-4 border-sky bg-white/40 px-8 py-3 font-display text-[clamp(26px,4.3vw,56px)] font-bold text-ink backdrop-blur-sm transition-colors hover:bg-sky/20 lg:border-[6px] lg:px-16 lg:py-5">
                {c.branch.cta}
              </button>
            </>
          ) : (
            <h2 className="flex flex-col items-start gap-3 font-display text-[clamp(34px,5.3vw,66px)] font-thin leading-none text-ink lg:gap-5">
              <span>{c.branch.line1}</span>
              <span className="w-fit rounded-[100px] border-4 border-sky bg-white/40 px-8 py-2 font-bold backdrop-blur-sm lg:border-[6px] lg:px-14 lg:py-3">
                {c.branch.cta}
              </span>
              <span>{c.branch.line2}</span>
            </h2>
          )}
        </div>
      </div>

      {/* Two branch cards */}
      <div className="relative z-20 -mt-24 px-4 lg:absolute lg:inset-x-0 lg:bottom-0 lg:mt-0 lg:translate-y-[78%] lg:px-0">
        <div className="mx-auto grid max-w-page gap-5 md:grid-cols-2 md:gap-[30px] md:px-12 lg:px-16">
          {branches.map((b, i) => (
            <div
              key={i}
              className="rounded-card bg-white p-6 text-center shadow-[0_30px_70px_rgba(0,0,0,0.12)] backdrop-blur-[15px] md:p-10"
            >
              <h3 className="mb-6 font-display text-[clamp(24px,2.4vw,32px)] font-extrabold text-ink">
                {b.name}
              </h3>
              <ul className="mb-8 space-y-3 font-display text-[clamp(15px,1.4vw,20px)] font-thin text-ink">
                <li className="flex items-center justify-center gap-2">
                  <PinIcon className="shrink-0 text-red" />
                  <span>{b.address}</span>
                </li>
                <li className="flex items-center justify-center gap-2">
                  <ClockIcon className="shrink-0 text-red" />
                  <span>{b.hours}</span>
                </li>
              </ul>
              <div className="flex gap-4">
                <button className="flex-[2] rounded-[18px] bg-sky py-4 font-display text-lg font-bold text-ink transition-opacity hover:opacity-90">
                  {c.branch.bookNow}
                </button>
                <button className="flex-1 rounded-[18px] bg-sky py-4 font-display text-lg font-bold text-ink transition-opacity hover:opacity-90">
                  {c.branch.details}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
