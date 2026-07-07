import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import Marquee from "@/components/Marquee";
import Hero from "@/components/sections/Hero";
import BranchMap from "@/components/sections/BranchMap";
import Offers from "@/components/sections/Offers";
import Services from "@/components/sections/Services";

export default function HomePage() {
  return (
    <main className="relative min-h-screen bg-cream">
      {/* Paper texture — blended with `luminosity` over the cream base so the
          grain stays but the warm page colour comes through (Figma 108:4083). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0 bg-[length:100%_auto] bg-top bg-repeat-y opacity-60 mix-blend-luminosity"
        style={{ backgroundImage: "url(/bg-texture.webp)" }}
      />
      <div className="relative z-10">
        <SiteHeader />
      <Hero />
      <Marquee />
      <BranchMap />
      <Offers />
      <Services />
      <SiteFooter />
      </div>
    </main>
  );
}
