"use client";

import { useEffect, useState } from "react";
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
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar user={user} branches={branches} signOutAction={signOutAction} />
        <main className="mx-auto w-full max-w-[1440px] flex-1 px-5 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
