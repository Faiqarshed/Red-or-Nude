"use client";

import { useState } from "react";
import { ChevronDown, Globe, LogOut, Search } from "lucide-react";
import { useAdminI18n } from "@/lib/admin/i18n";
import { ROLE_LABELS } from "@/lib/auth/rbac";
import type { SessionStaff } from "@/lib/auth/guard";
import type { Localized } from "@/lib/db/schema";
import { cn } from "@/lib/cn";

export type BranchOption = { id: string; name: Localized };

export default function Topbar({
  user,
  branches,
  signOutAction,
}: {
  user: SessionStaff;
  branches: BranchOption[];
  signOutAction: () => Promise<void>;
}) {
  const { t, lang, toggle } = useAdminI18n();
  const [menuOpen, setMenuOpen] = useState(false);

  // Owners can switch context across branches; everyone else is pinned to theirs
  // by scopedBranchId() on the server — the selector is read-only for them.
  const isOwner = user.role === "owner";
  const ownBranch = branches.find((b) => b.id === user.branchId);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-black/[0.06] bg-white/90 px-5 backdrop-blur">
      {/* ⌘K palette lands with Bookings in P1, when there's something to search. */}
      <div className="relative hidden max-w-xs flex-1 md:block">
        <Search
          className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-ink/30"
          strokeWidth={1.75}
        />
        <input
          disabled
          placeholder={t.topbar.search}
          className="h-9 w-full cursor-not-allowed rounded-xl border border-black/[0.06] bg-white/60 ps-9 pe-3 text-sm text-ink placeholder:text-ink/30"
        />
      </div>

      <div className="ms-auto flex items-center gap-2">
        <span className="hidden rounded-xl border border-black/[0.06] bg-white px-3 py-1.5 text-xs text-ink/60 sm:inline">
          {isOwner
            ? t.topbar.allBranches
            : (ownBranch?.name?.[lang] ?? t.topbar.branch)}
        </span>

        <button
          onClick={toggle}
          className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-black/[0.06] bg-white px-3 text-xs font-medium text-ink/70 transition-colors hover:text-ink"
          title={lang === "ar" ? "English" : "العربية"}
        >
          <Globe className="h-3.5 w-3.5" strokeWidth={1.75} />
          {lang === "ar" ? "EN" : "ع"}
        </button>

        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-black/[0.06] bg-white ps-2 pe-2.5 text-xs transition-colors hover:bg-black/[0.02]"
          >
            <span className="grid h-6 w-6 place-items-center rounded-lg bg-red-grad text-[10px] font-bold text-white">
              {user.name.charAt(0).toUpperCase()}
            </span>
            <span className="hidden text-start sm:block">
              <span className="block leading-tight text-ink">{user.name}</span>
              <span className="block text-[10px] leading-tight text-ink/45">
                {ROLE_LABELS[user.role][lang]}
              </span>
            </span>
            <ChevronDown
              className={cn("h-3.5 w-3.5 text-ink/40 transition-transform", menuOpen && "rotate-180")}
              strokeWidth={2}
            />
          </button>

          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute end-0 z-20 mt-1.5 w-52 overflow-hidden rounded-xl border border-black/[0.06] bg-white p-1 shadow-lg">
                <div className="px-3 py-2 text-start">
                  <p className="truncate text-xs font-medium text-ink">{user.name}</p>
                  <p className="truncate text-[11px] text-ink/45">{user.email}</p>
                </div>
                <form action={signOutAction}>
                  <button
                    type="submit"
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-xs text-red transition-colors hover:bg-red/[0.06]"
                  >
                    <LogOut className="h-3.5 w-3.5 rtl:rotate-180" strokeWidth={1.75} />
                    {t.topbar.signOut}
                  </button>
                </form>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
