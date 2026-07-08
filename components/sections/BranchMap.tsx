import { PinIcon, ClockIcon } from "../icons";

// Exact copy from Figma (Frame 64 + branch cards 108:4308).
const branches = [
  {
    name: "فــرع العروبـــة",
    address: "شــارع صــلاح الديــن الايوبــي ، مبنــى الثلاثــون",
    hours: "مواعيــد العمــل: 9 صباحــاً الــى 11 مســاءً",
  },
  {
    name: "فــرع الملقــا",
    address: "شــارع صــلاح الديــن الايوبــي ، مبنــى الثلاثــون",
    hours: "مواعيــد العمــل: 9 صباحــاً الــى 11 مســاءً",
  },
];

export default function BranchMap() {
  return (
    <section id="branches" className="relative z-10 lg:-mb-[9%]">
      {/* Clean map — no top overlay. Full width, faded to cream on the right so
          the heading stays readable. */}
      <div
        className="relative h-[70vh] min-h-[540px] w-full overflow-hidden bg-[#f3eee6] bg-no-repeat [background-position:64%_center] [background-size:auto_105%] lg:h-screen lg:min-h-[680px] lg:[background-position:center_40%] lg:[background-size:150%_auto]"
        style={{ backgroundImage: "url(/map-riyadh.webp)" }}
      >
        {/* Right-side cream fade behind the heading — reaches well past centre
            so the bright patch sits further left */}
        <div className="pointer-events-none absolute inset-y-0 right-0 w-[58%] bg-gradient-to-l from-cream via-cream/80 to-transparent lg:w-[70%] lg:via-cream/80" />

        {/* Heading + booking button — vertically centred on the right */}
        <div className="absolute inset-y-0 right-0 flex flex-col justify-center gap-5 px-6 text-right md:px-16 lg:gap-8 lg:px-24">
          <h2 className="font-display text-[clamp(34px,5.3vw,66px)] font-thin leading-[1.5] text-ink">
            {/* top line sits slightly left of the bottom line (Figma) */}
            <span className="block pr-[0.6em]">اختـــاري</span>
            <span className="block">الفـــرع</span>
          </h2>
          <button className="w-fit self-end rounded-[100px] border-4 border-sky bg-white/40 px-8 py-3 font-display text-[clamp(26px,4.3vw,56px)] font-bold text-ink backdrop-blur-sm transition-colors hover:bg-sky/20 lg:border-[6px] lg:px-16 lg:py-5">
            للحجــز
          </button>
        </div>
      </div>

      {/* Two branch cards — static (stacked) on mobile, overlapping the offers
          band on desktop. */}
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
                  <span>{b.address}</span>
                  <PinIcon className="shrink-0 text-red" />
                </li>
                <li className="flex items-center justify-center gap-2">
                  <span>{b.hours}</span>
                  <ClockIcon className="shrink-0 text-red" />
                </li>
              </ul>
              <div className="flex gap-4">
                <button className="flex-[2] rounded-[18px] bg-sky py-4 font-display text-lg font-bold text-ink transition-opacity hover:opacity-90">
                  احجزي الان
                </button>
                <button className="flex-1 rounded-[18px] bg-sky py-4 font-display text-lg font-bold text-ink transition-opacity hover:opacity-90">
                  التفاصيل
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
