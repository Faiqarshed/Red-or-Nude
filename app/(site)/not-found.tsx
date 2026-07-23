// Catch-all 404 for the public site.
//
// The app has two root layouts (site and admin), so an unmatched URL belongs to
// neither and Next falls back to the pages-router error document — which this
// build does not emit, turning every 404 into a 500. A catch-all inside each
// group keeps 404s in the app router where they belong.

import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col bg-cream">
      <SiteHeader />
      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-32 text-center">
        <p className="font-display text-[clamp(64px,12vw,140px)] font-thin leading-none text-red/25">404</p>
        <Link
          href="/"
          className="rounded-[100px] bg-red-grad px-10 py-3.5 text-sm font-bold text-white transition-opacity hover:opacity-90"
        >
          REDorNUDE
        </Link>
      </div>
      <SiteFooter />
    </main>
  );
}
