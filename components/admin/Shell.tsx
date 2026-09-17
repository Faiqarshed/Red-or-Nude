"use client";

import { useEffect, useState } from "react";
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
    <div className="flex min-h-screen bg-cream">
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
          {children}
        </main>
      </div>
    </div>
  );
}
