"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import AdminSkeleton from "./AdminSkeleton";
import { GoingToContext } from "./going-to";
import MobileNav from "./MobileNav";
import Sidebar from "./Sidebar";
import Topbar, { type BranchOption } from "./Topbar";
import type { SessionStaff } from "@/lib/auth/guard";

const COLLAPSE_KEY = "ron-admin-sidebar";

export default function Shell({
  user,
  branches,
  signOutAction,
  children,
}: {
  user: SessionStaff;
  branches: BranchOption[];
  signOutAction: () => Promise<void>;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);

  // The mobile sheet is deliberately *not* persisted the way `collapsed` is: a
  // rail width is a preference, an open drawer is a moment.
  const [navOpen, setNavOpen] = useState(false);

  // Read the persisted preference after mount (same pattern as the language
  // providers: never write from an effect, only from the toggle).
  useEffect(() => {
    if (localStorage.getItem(COLLAPSE_KEY) === "1") setCollapsed(true);
  }, []);

  // A click on a link to another admin page shows that page's skeleton at
  // once. Without this the old page sat there until the server began to
  // answer (in development, where nothing is prefetched, every time), and it
  // looked like the click had done nothing, so she clicked again. Kept per
  // address: once the address changes, loading.tsx and then the page take
  // over, in the same shape. The old page stays mounted underneath, hidden,
  // so a navigation that goes nowhere loses nothing.
  const pathname = usePathname();
  const [going, setGoing] = useState<{ from: string; to: string } | null>(null);
  const goingTo = going && going.from === pathname ? going.to : null;

  const noticeNavigation = (e: React.MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = (e.target as HTMLElement).closest("a");
    if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
    const to = new URL(link.href, window.location.href);
    // Another tab or filter on this same page is not a new page.
    if (to.origin !== window.location.origin || !to.pathname.startsWith("/admin") || to.pathname === pathname) return;
    setGoing({ from: pathname, to: to.pathname });
  };

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  return (
    <GoingToContext.Provider value={goingTo}>
    <div className="flex min-h-screen bg-cream" onClickCapture={noticeNavigation}>
      <Sidebar role={user.role} collapsed={collapsed} onToggle={toggle} />
      <MobileNav role={user.role} open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          user={user}
          branches={branches}
          signOutAction={signOutAction}
          navOpen={navOpen}
          onOpenNav={() => setNavOpen(true)}
        />
        <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-5 sm:px-5 sm:py-6 lg:px-8">
          {goingTo ? <AdminSkeleton path={goingTo} /> : null}
          <div hidden={Boolean(goingTo)}>{children}</div>
        </main>
      </div>
    </div>
    </GoingToContext.Provider>
  );
}
