"use client";

// What a site page shows while it loads (app/(site)/loading.tsx).
//
// Every page renders its own fixed SiteHeader and starts 120px down beneath it,
// so a skeleton does the same. Without that the header vanished while a page
// loaded, and the content dropped 80px when the page arrived. /booking,
// /account and /my-bookings get their page's own container and columns, so what
// fills in lands where the grey was.
//
// One loading.tsx for the whole site, choosing by the address she is going to.
// A loading.tsx per route flashed the site's generic one first: loaders nest,
// and the outer one shows until the inner one is fetched, which in development
// (no prefetch) is every click. usePathname already reads the new address while
// the loader shows.

import { usePathname } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import { useAccount } from "@/lib/account/context";
import { useI18n } from "@/lib/i18n";

export function SiteSkeleton() {
  const path = usePathname();
  if (path === "/booking") return <BookingSkeleton />;
  if (path === "/account") return <AccountSkeleton />;
  if (path === "/my-bookings") return <MyBookingsSkeleton />;
  return (
    <SkeletonPage className="max-w-5xl space-y-4">
      <Bone className="h-8 w-56 rounded-xl" />
      <Bone className="h-64 rounded-2xl" />
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Bone key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
    </SkeletonPage>
  );
}

/** The page around a skeleton: cream, the header, and the page's container (`className`). */
function SkeletonPage({ className, children }: { className: string; children: React.ReactNode }) {
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
function Bone({ className }: { className: string }) {
  return <div className={`animate-pulse bg-black/[0.05] ${className}`} />;
}

/** BookingView: the branch picker and the service cards, with the summary beside them. */
function BookingSkeleton() {
  return (
    <SkeletonPage className="grid max-w-page gap-8 lg:grid-cols-[1fr_360px] lg:px-16">
      <div className="space-y-10">
        <div>
          <Bone className="mb-5 h-8 w-48 rounded-xl" />
          <div className="flex flex-wrap gap-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Bone key={i} className="h-11 w-32 rounded-[14px]" />
            ))}
          </div>
        </div>
        <div>
          <Bone className="mb-5 h-8 w-56 rounded-xl" />
          <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Bone key={i} className="h-[196px] rounded-[20px]" />
            ))}
          </div>
        </div>
        {/* Book for a group, and the memberships row. */}
        <Bone className="h-[76px] rounded-[20px]" />
        <Bone className="h-[76px] rounded-[20px]" />
      </div>
      <Bone className="h-[420px] rounded-[24px] lg:sticky lg:top-[110px]" />
    </SkeletonPage>
  );
}

/** AccountView. Signed in: her name, then bookings beside points, memberships and profile. Signed out: the sign-in card. */
function AccountSkeleton() {
  const signedIn = useAccount();

  if (!signedIn) {
    return (
      <SkeletonPage className="max-w-[520px]">
        <Bone className="h-9 w-48 rounded-xl" />
        <Bone className="mt-2 h-4 w-72 rounded-lg" />
        <Bone className="mt-7 h-[220px] rounded-[20px]" />
      </SkeletonPage>
    );
  }

  return (
    <SkeletonPage className="max-w-page lg:px-16">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Bone className="h-9 w-56 rounded-xl" />
          <Bone className="mt-2 h-4 w-40 rounded-lg" />
        </div>
        <Bone className="h-9 w-24 rounded-[12px]" />
      </div>
      <div className="mt-8 grid items-start gap-8 lg:grid-cols-[1fr_380px] lg:grid-rows-[auto_1fr]">
        <div className="space-y-6 self-start lg:col-start-2 lg:row-start-1">
          <Bone className="h-[180px] rounded-[20px]" />
          <Bone className="h-[140px] rounded-[20px]" />
        </div>
        <div className="self-start lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <Bone className="h-6 w-40 rounded-lg" />
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Bone key={i} className="h-[168px] rounded-[20px]" />
            ))}
          </div>
        </div>
        <Bone className="h-[320px] self-start rounded-[20px] lg:col-start-2 lg:row-start-2" />
      </div>
    </SkeletonPage>
  );
}

/** MyBookingsView: the narrow column with the title and the booking reference box. */
function MyBookingsSkeleton() {
  return (
    <SkeletonPage className="max-w-[760px]">
      <Bone className="h-9 w-56 rounded-xl" />
      <Bone className="mt-2 h-4 w-72 rounded-lg" />
      <Bone className="mt-3 h-4 w-60 rounded-lg" />
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Bone className="h-[66px] flex-1 rounded-[12px]" />
        <Bone className="h-[46px] w-32 self-end rounded-[12px]" />
      </div>
    </SkeletonPage>
  );
}
