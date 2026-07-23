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
      {/* Warm paper texture — a seamless 1024px tile (warm greige base + soft
          mottle + fine grain) baked to match Figma 108:4083. Tiles both axes so
          the grain stays crisp at any width instead of upscaling. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0 bg-[length:1024px_1024px] bg-repeat"
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
