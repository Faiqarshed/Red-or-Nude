"use client";

import { useEffect, useState } from "react";

// Figma "Loader" — عروض carousel. Each exported slide already contains its own
// heading and dot state, so we simply crossfade between them.
const slides = [
  "/eid-offers.webp",
  "/Property1Variant2.webp",
  "/Property1Variant3.webp",
  "/Property1Variant4.webp",
];

// Portrait versions used on mobile (Figma 430×700).
const mobileSlides = ["/1.webp", "/2.webp", "/3.webp", "/4.webp"];

export default function Offers() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setActive((i) => (i + 1) % slides.length), 3500);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="relative overflow-hidden rounded-b-[40px] bg-[#7d5c38] pt-8 md:rounded-b-[100px] lg:pt-[20%]">
      {/* Mobile — portrait slides */}
      <div className="relative aspect-[43/70] w-full lg:hidden">
        {mobileSlides.map((src, i) => (
          <div
            key={src}
            className={`absolute inset-0 bg-cover bg-center transition-opacity duration-1000 ${
              i === active ? "opacity-100" : "opacity-0"
            }`}
            style={{ backgroundImage: `url(${src})` }}
            aria-hidden={i !== active}
          />
        ))}
      </div>

      {/* Desktop — 16/9 slides */}
      <div className="relative hidden aspect-[16/9] w-full lg:block">
        {slides.map((src, i) => (
          <div
            key={src}
            className={`absolute inset-0 bg-cover bg-center transition-opacity duration-1000 ${
              i === active ? "opacity-100" : "opacity-0"
            }`}
            style={{ backgroundImage: `url(${src})` }}
            aria-hidden={i !== active}
          />
        ))}
      </div>
    </section>
  );
}
