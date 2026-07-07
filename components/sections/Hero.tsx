import Link from "next/link";

// Booking cards — exact copy from Figma (108:4116). RTL order: right → left.
const serviceCards = [
  { kicker: "الحجــز", title: "احجــزي موعــدًا", desc: "حدّد الخدمات لنفسك", href: "/booking" },
  { kicker: "الحجــز", title: "موعــد جماعـــي", desc: "لـنـفـسـك وللآخـريــن", href: "/booking" },
  { kicker: "اشتــر", title: "بطاقــة هديــة", desc: "دلّلي نفسك أو صديقتك بزيارات مستقبلية", href: "/gift-card" },
];

function CardArrow() {
  // Red capsule outline (Figma 108:4121) — narrower on mobile.
  return (
    <span className="block h-[26px] w-[70px] rounded-full border-[2px] border-red md:w-[103px]" />
  );
}

export default function Hero() {
  return (
    <>
      {/* ── Mobile hero: big centred wordmark (z-10) with the zoomed manicure
           photo overlapping it from the right (z-20) ── */}
      <section
        className="relative w-full overflow-hidden pt-16 md:hidden"
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
              src="/hero-hands.png"
              alt=""
              className="absolute right-0 top-0 h-full max-w-none select-none"
            />
          </div>
        </div>
      </section>

      {/* ── Desktop hero splash: wordmark (z-10) behind the photo (z-20) ── */}
      <section className="relative hidden h-screen min-h-[680px] w-full overflow-hidden md:block">
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
          style={{ left: "calc(280px + 19.5vw)", top: "-20px", width: "1180px" }}
        >
          <div className="h-full w-full" style={{ transform: "rotate(-1.6deg)" }}>
            <img
              src="/hero-hands.png"
              alt=""
              className="absolute right-0 top-0 h-full max-w-none select-none"
            />
          </div>
        </div>
      </section>

      {/* Three booking cards (Figma: 530×320, radius 36, gap 30) — below the fold */}
      <section className="mx-auto w-full max-w-page px-6 pb-16 pt-12 md:px-12 lg:px-16">
        <div className="grid grid-cols-1 gap-[30px] md:grid-cols-3">
          {serviceCards.map((c) => (
            <Link
              key={c.title}
              href={c.href}
              className="relative block rounded-card bg-white px-[8.7%] py-[9%] text-right shadow-[0_20px_50px_rgba(184,0,7,0.06)] transition-shadow hover:shadow-[0_24px_60px_rgba(184,0,7,0.12)] md:aspect-[530/320]"
            >
              <p className="font-display text-[clamp(18px,1.35vw,26px)] font-light text-ink">
                {c.kicker}
              </p>
              <h3 className="mt-[5%] font-display text-[clamp(26px,2.1vw,40px)] font-extrabold text-red">
                {c.title}
              </h3>
              <p className="mt-[6%] font-display text-[clamp(16px,1.35vw,26px)] font-light leading-relaxed text-ink">
                {c.desc}
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
