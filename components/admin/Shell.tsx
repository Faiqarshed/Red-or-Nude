"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import AdminSkeleton from "./AdminSkeleton";
import MobileNav from "./MobileNav";
import Sidebar from "./Sidebar";
import Topbar, { type BranchOption } from "./Topbar";
import { ACTION_FAILED } from "./use-pending-action";
import type { SessionStaff } from "@/lib/auth/guard";
import { useAdminI18n } from "@/lib/admin/i18n";

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
  const { t } = useAdminI18n();
  const [collapsed, setCollapsed] = useState(false);

  // An action that threw anywhere in the panel (usePendingAction): one notice
  // here, rather than a message written into each of its forty callers. Stays
  // until dismissed — it asks her to check something.
  const [actionFailed, setActionFailed] = useState(false);
  useEffect(() => {
    const show = () => setActionFailed(true);
    window.addEventListener(ACTION_FAILED, show);
    return () => window.removeEventListener(ACTION_FAILED, show);
  }, []);

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
    <div className="flex min-h-screen bg-cream" onClickCapture={noticeNavigation}>
      <Sidebar role={user.role} collapsed={collapsed} onToggle={toggle} goingTo={goingTo} />
      <MobileNav role={user.role} open={navOpen} onClose={() => setNavOpen(false)} goingTo={goingTo} />
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
      {actionFailed ? (
        <div
          role="alert"
          className="fixed inset-x-4 bottom-4 z-[60] mx-auto flex max-w-md items-start gap-3 rounded-xl bg-white px-4 py-3 text-start text-sm text-red shadow-lg ring-1 ring-red/20"
        >
          <p className="flex-1">{t.common.actionUnconfirmed}</p>
          <button
            type="button"
            onClick={() => setActionFailed(false)}
            className="shrink-0 text-xs font-semibold text-ink/50 underline underline-offset-4 hover:text-ink"
          >
            {t.common.dismiss}
          </button>
        </div>
      ) : null}
    </div>
  );
}
