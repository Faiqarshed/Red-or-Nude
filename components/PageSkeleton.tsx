"use client";

// What a site page shows while it loads (app/(site)/**/loading.tsx).
//
// Every page renders its own fixed SiteHeader and starts 120px down beneath it,
// so a skeleton does the same. Without that the header vanished while a page
// loaded, and the content dropped 80px when the page arrived. Each route's
// loading.tsx then copies its page's container and columns, so what fills in
// lands where the grey was.

import SiteHeader from "@/components/SiteHeader";
import { useI18n } from "@/lib/i18n";

/** The page around a skeleton: cream, the header, and the page's container (`className`). */
export function SkeletonPage({ className, children }: { className: string; children: React.ReactNode }) {
  const { c } = useI18n();
  return (
    <main className="min-h-screen bg-cream" aria-busy="true" aria-live="polite">
      <SiteHeader />
      <span className="sr-only">{c.header.loading}</span>
      <div className={`mx-auto px-6 pb-20 pt-[120px] md:px-12 ${className}`}>{children}</div>
    </main>
  );
}

/** One grey block, sized and rounded like the thing it stands in for. */
export function Bone({ className }: { className: string }) {
  return <div className={`animate-pulse bg-black/[0.05] ${className}`} />;
}
