"use client";

// What the panel shows while a screen renders on the server (loading.tsx), and
// the moment a link is clicked (Shell).
//
// Each screen gets its own shape, drawn from the real screen: the same
// header controls, cards, rows and columns in the same places, so what
// arrives lands where the grey was. The panel used to show the same eight
// bars for every screen, padded twice inside the shell's own padding, and the
// page jumped and changed shape when it came. Screens without a shape of
// their own (bookings, no-shows, customers, gift cards, discount codes, the
// audit log) are a list: header, search, table.

import { usePathname } from "next/navigation";
import { useAdminI18n } from "@/lib/admin/i18n";
import { cn } from "@/lib/cn";

const SHAPES: [string, () => React.ReactElement][] = [
  ["/admin/front-desk", FrontDesk],
  ["/admin/floor", Team],
  ["/admin/my-day", Desk],
  ["/admin/availability", Availability],
  ["/admin/catalog", Catalog],
  ["/admin/memberships", Memberships],
  ["/admin/staff", Staff],
  ["/admin/technicians", Technicians],
  ["/admin/performance", Performance],
  ["/admin/reviews", Reviews],
  ["/admin/media", Gallery],
];

/** `path` is the page being opened, when Shell knows it before the address changes. */
export default function AdminSkeleton({ path: goingTo }: { path?: string }) {
  const { t } = useAdminI18n();
  const current = usePathname();
  const path = goingTo ?? current;
  const Shape = path === "/admin" ? Dashboard : (SHAPES.find(([p]) => path.startsWith(p))?.[1] ?? List);
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">{t.common.loading}</span>
      <Shape />
    </div>
  );
}

// ---------------------------------------------------------------- pieces ---

function Bone({ className }: { className: string }) {
  return <div className={cn("animate-pulse rounded-md bg-black/[0.06]", className)} />;
}

/** The panel's Card. */
function Box({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <div className={cn("rounded-2xl border border-black/[0.06] bg-white shadow-[0_1px_2px_rgba(24,23,23,0.04)]", className)}>
      {children}
    </div>
  );
}

/** A branch picker or a date stepper: a white control with an outline. */
function Control({ className }: { className: string }) {
  return <div className={cn("rounded-xl border border-black/[0.08] bg-white", className)} />;
}

/** The red "New …" button. */
function Primary() {
  return <div className="h-10 w-36 animate-pulse rounded-xl bg-red/15" />;
}

/** PageHeader: title and subtitle, with whatever sits on the right. */
function Header({ children }: { children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <Bone className="h-7 w-44" />
        <Bone className="mt-2.5 h-4 w-72 max-w-[60vw]" />
      </div>
      {children ? <div className="flex items-center gap-2">{children}</div> : null}
    </div>
  );
}

const Toggle = () => <Bone className="h-5 w-9 shrink-0 rounded-full" />;
const times = (n: number) => Array.from({ length: n }, (_, i) => i);

/** A card of rows: a picture, a name over a line, and what sits at the end. */
function RowCard({ rows, end }: { rows: number; end: React.ReactNode }) {
  return (
    <Box className="overflow-hidden">
      {times(rows).map((i) => (
        <div key={i} className="flex items-center gap-4 border-b border-black/[0.05] px-4 py-3 last:border-0">
          <Bone className="h-12 w-12 shrink-0 rounded-xl" />
          <div className="flex-1">
            <Bone className="h-4 w-40" />
            <Bone className="mt-2 h-3 w-20" />
          </div>
          {end}
        </div>
      ))}
    </Box>
  );
}

/** Price, reorder arrows and the on/off switch, as catalogue and memberships end a row. */
const PriceEnd = (
  <>
    <Bone className="h-4 w-16" />
    <Bone className="hidden h-4 w-12 sm:block" />
    <Toggle />
  </>
);

/** A one-line card per technician, as Today's team and Technicians list them. */
function PersonCards({ rows, height, gap, action }: { rows: number; height: string; gap: string; action?: boolean }) {
  return (
    <div className={gap}>
      {times(rows).map((i) => (
        <Box key={i} className={cn("flex items-center gap-3 px-5", height)}>
          <Bone className="h-4 w-4" />
          <Bone className="h-5 w-32" />
          <Bone className="h-3 w-10" />
          <Bone className="h-3 w-16" />
          {action ? <Control className="ms-auto h-8 w-24" /> : null}
        </Box>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- screens ---

/** A list: header, search or tabs, and a table in a card. */
function List() {
  return (
    <>
      <Header>
        <Primary />
      </Header>
      <Control className="mb-4 h-10 w-72" />
      <Box className="overflow-hidden">
        <div className="flex gap-6 border-b border-black/[0.06] bg-black/[0.015] px-4 py-3">
          {["w-20", "w-28", "w-16", "w-12"].map((w) => (
            <Bone key={w} className={cn("h-3", w)} />
          ))}
        </div>
        {times(8).map((i) => (
          <div key={i} className="flex items-center gap-6 border-b border-black/[0.04] px-4 py-3.5 last:border-0">
            <Bone className="h-9 w-9 shrink-0 rounded-full" />
            <div className="flex-1">
              <Bone className="h-3.5 w-1/3" />
              <Bone className="mt-2 h-3 w-1/5" />
            </div>
            <Bone className="hidden h-3.5 w-24 sm:block" />
            <Bone className="h-6 w-16 rounded-full" />
          </div>
        ))}
      </Box>
    </>
  );
}

/** DashboardView: the code banner, two big figures, three small ones, two columns of cards. */
function Dashboard() {
  const rows = (
    <Box>
      <div className="border-b border-black/[0.06] px-5 py-4">
        <Bone className="h-4 w-32" />
      </div>
      {times(3).map((i) => (
        <div key={i} className="flex items-center gap-4 border-b border-black/[0.04] px-5 py-4 last:border-0">
          <Bone className="h-10 w-10 rounded-xl" />
          <div className="flex-1">
            <Bone className="h-3.5 w-1/3" />
            <Bone className="mt-2 h-3 w-1/4" />
          </div>
          <Bone className="h-2 w-24 rounded-full" />
        </div>
      ))}
    </Box>
  );
  return (
    <>
      <Box className="mb-6 h-[104px]" />
      <Header />
      <div className="grid gap-4 lg:grid-cols-2">
        {times(2).map((i) => (
          <Box key={i} className="h-[176px] p-6">
            <Bone className="h-4 w-28" />
            <Bone className="mt-4 h-10 w-24" />
          </Box>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
        {times(3).map((i) => (
          <Box key={i} className="h-[104px] p-5">
            <Bone className="h-4 w-24" />
            <Bone className="mt-3 h-7 w-10" />
          </Box>
        ))}
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        {rows}
        {rows}
      </div>
    </>
  );
}

/** Front desk: four lanes, the ticket search, and everything else today. */
function FrontDesk() {
  return (
    <>
      <Header>
        <Control className="h-10 w-40" />
      </Header>
      <div className="mb-6 grid gap-4 xl:grid-cols-2">
        {times(4).map((i) => (
          <Box key={i} className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-black/[0.05] bg-black/[0.02] px-4 py-3">
              <Bone className="h-3 w-32" />
              <Bone className="h-3 w-3" />
            </div>
            <div className="grid h-[72px] place-items-center">
              <Bone className="h-3 w-36" />
            </div>
          </Box>
        ))}
      </div>
      <Box className="mb-6 p-5">
        <Bone className="h-3 w-36" />
        <div className="mt-2.5 flex items-end gap-3">
          <Bone className="h-16 flex-1 rounded-xl" />
          <div className="h-10 w-24 animate-pulse rounded-xl bg-red/15" />
        </div>
      </Box>
      <Box className="overflow-hidden">
        <div className="border-b border-black/[0.06] px-4 py-4">
          <Bone className="h-4 w-40" />
        </div>
        {times(5).map((i) => (
          <div key={i} className="flex items-center gap-5 border-b border-black/[0.04] px-4 py-3 last:border-0">
            <Bone className="h-5 w-8" />
            <Bone className="h-3 w-10" />
            <Bone className="h-11 w-11 rounded-xl" />
            <div className="flex-1">
              <Bone className="h-4 w-36" />
              <Bone className="mt-2 h-3 w-20" />
            </div>
            <Bone className="hidden h-3 w-20 sm:block" />
            <Bone className="h-5 w-16 rounded-full" />
          </div>
        ))}
      </Box>
    </>
  );
}

/** Today's team: a card per technician, with Send home. */
function Team() {
  return (
    <>
      <Header>
        <Control className="h-10 w-40" />
      </Header>
      <PersonCards rows={5} height="h-[58px]" gap="space-y-4" action />
    </>
  );
}

/** My day: a technician's own cards. */
function Desk() {
  return (
    <>
      <Header />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {times(4).map((i) => (
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

/** Availability: the week's hours, then chairs beside closures. */
function Availability() {
  const cardHead = (
    <div className="border-b border-black/[0.06] px-5 py-4">
      <Bone className="h-4 w-28" />
    </div>
  );
  return (
    <>
      <Header>
        <Control className="h-10 w-40" />
      </Header>
      <Box className="overflow-hidden">
        {cardHead}
        {times(7).map((i) => (
          <div key={i} className="flex items-center gap-4 border-b border-black/[0.05] px-5 py-3 last:border-0">
            <Bone className="h-4 w-24" />
            <Toggle />
            <Bone className="h-9 w-28 rounded-lg" />
            <Bone className="h-px w-3" />
            <Bone className="h-9 w-28 rounded-lg" />
          </div>
        ))}
      </Box>
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Box className="overflow-hidden">
          {cardHead}
          {times(4).map((i) => (
            <div key={i} className="flex items-center gap-3 border-b border-black/[0.05] px-5 py-4 last:border-0">
              <Bone className="h-4 w-6" />
              <div className="ms-auto flex items-center gap-4">
                <Toggle />
                <Bone className="h-4 w-4" />
              </div>
            </div>
          ))}
        </Box>
        <Box className="overflow-hidden">
          {cardHead}
          <div className="grid h-16 place-items-center border-b border-black/[0.05]">
            <Bone className="h-3 w-24" />
          </div>
          <div className="grid grid-cols-2 gap-3 p-4">
            <Bone className="h-10 rounded-xl" />
            <Bone className="h-10 rounded-xl" />
          </div>
        </Box>
      </div>
    </>
  );
}

/** Catalogue: the four tabs, then the rows of the tab. */
function Catalog() {
  return (
    <>
      <Header>
        <Primary />
      </Header>
      <Box className="mb-4 grid grid-cols-4 gap-1 p-1">
        {times(4).map((i) => (
          <div key={i} className="grid h-9 place-items-center">
            <Bone className="h-3.5 w-16" />
          </div>
        ))}
      </Box>
      <RowCard rows={6} end={PriceEnd} />
    </>
  );
}

/** Memberships: the rows, priced, in order. */
function Memberships() {
  return (
    <>
      <Header>
        <Primary />
      </Header>
      <RowCard rows={3} end={PriceEnd} />
    </>
  );
}

/** Staff: a row per account, with role, code, last sign-in and the switch. */
function Staff() {
  return (
    <>
      <Header>
        <Primary />
      </Header>
      <Box className="overflow-hidden">
        {times(8).map((i) => (
          <div key={i} className="flex items-center gap-4 border-b border-black/[0.05] px-4 py-3 last:border-0">
            <Bone className="h-9 w-9 shrink-0 rounded-xl" />
            <div className="flex-1">
              <Bone className="h-4 w-32" />
              <Bone className="mt-2 h-3 w-40" />
            </div>
            <Bone className="hidden h-5 w-20 rounded-full sm:block" />
            <Bone className="hidden h-4 w-24 md:block" />
            <Bone className="hidden h-3 w-20 lg:block" />
            <Toggle />
            <Bone className="h-4 w-4" />
          </div>
        ))}
      </Box>
    </>
  );
}

/** Technicians: the day and branch, then a card per technician. */
function Technicians() {
  return (
    <>
      <Header />
      <div className="mb-4 flex flex-wrap gap-2">
        <Control className="h-[42px] w-56" />
        <Control className="h-[42px] w-40" />
      </div>
      <PersonCards rows={5} height="h-[50px]" gap="space-y-3" />
    </>
  );
}

/** Performance: branch and period, then the table of timings. */
function Performance() {
  return (
    <>
      <Header>
        <Control className="h-10 w-40" />
        <Bone className="h-10 w-48 rounded-xl" />
      </Header>
      <Box className="overflow-hidden">
        <div className="flex gap-10 border-b border-black/[0.06] bg-black/[0.015] px-4 py-3">
          {["w-24", "w-16", "w-16", "w-16"].map((w, i) => (
            <Bone key={i} className={cn("h-3", w)} />
          ))}
        </div>
        {times(5).map((i) => (
          <div key={i} className="flex items-center gap-10 border-b border-black/[0.04] px-4 py-4 last:border-0">
            <Bone className="h-4 w-32" />
            <Bone className="h-4 w-12" />
            <Bone className="h-4 w-12" />
            <Bone className="h-4 w-12" />
          </div>
        ))}
      </Box>
    </>
  );
}

/** Reviews: three figures, then the table of answers. */
function Reviews() {
  return (
    <>
      <Header>
        <Control className="h-10 w-40" />
      </Header>
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        {times(3).map((i) => (
          <Box key={i} className="h-[116px] p-5">
            <Bone className="h-3 w-36" />
            <Bone className="mt-4 h-6 w-10" />
            <Bone className="mt-3 h-3 w-28" />
          </Box>
        ))}
      </div>
      <Box className="overflow-hidden">
        <div className="grid grid-cols-6 gap-6 border-b border-black/[0.06] bg-black/[0.015] px-4 py-3.5">
          {times(6).map((i) => (
            <Bone key={i} className="h-3 w-16" />
          ))}
        </div>
        {times(8).map((i) => (
          <div key={i} className="grid grid-cols-6 items-center gap-6 border-b border-black/[0.04] px-4 py-3 last:border-0">
            <div>
              <Bone className="h-3.5 w-28" />
              <Bone className="mt-1.5 h-3 w-16" />
            </div>
            <Bone className="h-4 w-20" />
            <Bone className="h-4 w-20" />
            <Bone className="h-3 w-16" />
            <Bone className="h-3 w-12" />
            <Bone className="h-3 w-10" />
          </div>
        ))}
      </Box>
    </>
  );
}

/** Media: a grid of pictures. */
function Gallery() {
  return (
    <>
      <Header>
        <Primary />
      </Header>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {times(10).map((i) => (
          <Bone key={i} className="aspect-square rounded-2xl" />
        ))}
      </div>
    </>
  );
}
