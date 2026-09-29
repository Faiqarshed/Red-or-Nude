"use client";

// What the panel shows while a screen renders on the server (loading.tsx).
//
// One shape per kind of screen, picked from the address being opened: the
// dashboard's cards, a list's header and table, the desk's cards, a form, the
// media grid. The panel used to show the same eight bars for all of them, and
// padded them twice (the shell's <main> already pads), so the page jumped
// sideways and changed shape when it arrived. These use the panel's own
// pieces, sized like the real ones, and no padding of their own.

import { usePathname } from "next/navigation";
import { useAdminI18n } from "@/lib/admin/i18n";
import { cn } from "@/lib/cn";

export default function AdminSkeleton() {
  const { t } = useAdminI18n();
  const path = usePathname();
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">{t.common.loading}</span>
      {path === "/admin" ? (
        <Dashboard />
      ) : path.startsWith("/admin/front-desk") || path.startsWith("/admin/floor") || path.startsWith("/admin/my-day") ? (
        <Desk />
      ) : path.startsWith("/admin/availability") ? (
        <Form />
      ) : path.startsWith("/admin/media") ? (
        <Gallery />
      ) : (
        <List />
      )}
    </div>
  );
}

function Bone({ className }: { className: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-black/[0.06]", className)} />;
}

/** The panel's Card, empty. */
function Box({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <div className={cn("rounded-2xl border border-black/[0.06] bg-white shadow-[0_1px_2px_rgba(24,23,23,0.04)]", className)}>
      {children}
    </div>
  );
}

/** PageHeader: title and subtitle, and the action button most screens have. */
function Header({ action = true }: { action?: boolean }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <Bone className="h-7 w-44" />
        <Bone className="mt-2 h-4 w-64" />
      </div>
      {action ? <Bone className="h-10 w-32 rounded-xl" /> : null}
    </div>
  );
}

/** A list screen: header, its tabs or search, and a table in a card. */
function List() {
  return (
    <>
      <Header />
      <Bone className="mb-4 h-10 w-72 rounded-xl" />
      <Box className="overflow-hidden">
        <div className="flex gap-6 border-b border-black/[0.06] bg-black/[0.015] px-4 py-3">
          {["w-20", "w-28", "w-16", "w-12"].map((w) => (
            <Bone key={w} className={cn("h-3", w)} />
          ))}
        </div>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex items-center gap-6 border-b border-black/[0.04] px-4 py-3.5 last:border-0">
            <Bone className="h-9 w-9 shrink-0 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Bone className="h-3.5 w-1/3" />
              <Bone className="h-3 w-1/5" />
            </div>
            <Bone className="hidden h-3.5 w-24 sm:block" />
            <Bone className="h-6 w-16 rounded-full" />
          </div>
        ))}
      </Box>
    </>
  );
}

/** DashboardView: two big figures, three small ones, then two columns of cards. */
function Dashboard() {
  return (
    <>
      <Box className="mb-6 h-[104px]" />
      <Header action={false} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Box className="h-[176px] p-6">
          <Bone className="h-4 w-28" />
          <Bone className="mt-4 h-10 w-24" />
        </Box>
        <Box className="h-[176px] p-6">
          <Bone className="h-4 w-28" />
          <Bone className="mt-4 h-10 w-24" />
        </Box>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Box key={i} className="h-[104px] p-5">
            <Bone className="h-4 w-24" />
            <Bone className="mt-3 h-7 w-10" />
          </Box>
        ))}
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <Rows />
        <Rows />
      </div>
    </>
  );
}

/** A card with a heading and a few rows, as the dashboard's lists are. */
function Rows() {
  return (
    <Box>
      <div className="border-b border-black/[0.06] px-5 py-4">
        <Bone className="h-4 w-32" />
      </div>
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-black/[0.04] px-5 py-4 last:border-0">
          <Bone className="h-10 w-10 rounded-xl" />
          <div className="flex-1 space-y-1.5">
            <Bone className="h-3.5 w-1/3" />
            <Bone className="h-3 w-1/4" />
          </div>
          <Bone className="h-2 w-24 rounded-full" />
        </div>
      ))}
    </Box>
  );
}

/** Front desk, floor and my day: a row of cards to act on. */
function Desk() {
  return (
    <>
      <Header />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Box key={i} className="h-[168px] p-5">
            <div className="flex items-center gap-3">
              <Bone className="h-9 w-9 rounded-xl" />
              <Bone className="h-4 w-24" />
            </div>
            <Bone className="mt-4 h-3.5 w-3/4" />
            <Bone className="mt-2 h-3.5 w-1/2" />
            <Bone className="mt-5 h-8 w-24 rounded-xl" />
          </Box>
        ))}
      </div>
    </>
  );
}

/** Availability: cards of settings in two columns. */
function Form() {
  return (
    <>
      <Header action={false} />
      <div className="grid gap-5 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Box key={i} className="p-5">
            <Bone className="mb-4 h-4 w-32" />
            <div className="space-y-2">
              {Array.from({ length: 4 }, (_, j) => (
                <Bone key={j} className="h-11 rounded-xl" />
              ))}
            </div>
          </Box>
        ))}
      </div>
    </>
  );
}

/** Media: a grid of pictures. */
function Gallery() {
  return (
    <>
      <Header />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {Array.from({ length: 10 }, (_, i) => (
          <Bone key={i} className="aspect-square rounded-2xl" />
        ))}
      </div>
    </>
  );
}
