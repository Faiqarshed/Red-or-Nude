"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarDays,
  Clock,
  FileText,
  Gift,
  IdCard,
  Images,
  LayoutDashboard,
  MapPin,
  Megaphone,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Settings,
  Sparkles,
  Star,
  Ticket,
  Timer,
  UserCog,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useAdminI18n } from "@/lib/admin/i18n";
import { can } from "@/lib/auth/rbac";
import type { StaffRole } from "@/lib/db/schema";
import { NAV } from "./nav";
import { cn } from "@/lib/cn";

const ICONS: Record<string, LucideIcon> = {
  LayoutDashboard,
  CalendarDays,
  Clock,
  Sparkles,
  Palette,
  Gift,
  Images,
  Users,
  IdCard,
  MapPin,
  FileText,
  Megaphone,
  Settings,
  ScrollText,
  Star,
  Ticket,
  Timer,
  UserCog,
};

export default function Sidebar({
  role,
  collapsed,
  onToggle,
}: {
  role: StaffRole;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useAdminI18n();
  const pathname = usePathname();

  return (
    <aside
      className={cn(
        "sticky top-0 flex h-screen shrink-0 flex-col border-e border-black/[0.06] bg-white transition-[width]",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <div className="flex h-14 items-center gap-2 border-b border-black/[0.06] px-4">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-red-grad text-[11px] font-bold text-white">
          R
        </span>
        {!collapsed && (
          <span className="truncate font-display text-sm font-bold text-ink">{t.panel}</span>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {NAV.map((group) => {
          // Hide a whole group when the role can't reach any item in it.
          const visible = group.items.filter((item) => !item.cap || can(role, item.cap));
          if (visible.length === 0) return null;

          return (
            <div key={group.key} className="mb-4">
              {!collapsed && (
                <p className="px-3 pb-1.5 text-start text-[10px] font-semibold uppercase tracking-wider text-ink/35">
                  {t.groups[group.key]}
                </p>
              )}
              <ul className="space-y-0.5">
                {visible.map((item) => {
                  const Icon = ICONS[item.icon] ?? LayoutDashboard;
                  const active =
                    item.href === "/admin"
                      ? pathname === "/admin"
                      : pathname.startsWith(item.href);
                  const label = t.nav[item.key];

                  const inner = (
                    <>
                      <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                      {!collapsed && <span className="truncate">{label}</span>}
                      {!collapsed && item.soon && (
                        <span className="ms-auto rounded-full bg-black/[0.05] px-1.5 py-0.5 text-[9px] font-medium text-ink/40">
                          {t.common.soon}
                        </span>
                      )}
                    </>
                  );

                  const base =
                    "flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors";

                  return (
                    <li key={item.key}>
                      {item.soon ? (
                        <span
                          className={cn(base, "cursor-not-allowed text-ink/35")}
                          title={t.common.comingSoon}
                          aria-disabled
                        >
                          {inner}
                        </span>
                      ) : (
                        <Link
                          href={item.href}
                          title={collapsed ? label : undefined}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            base,
                            active
                              ? "bg-red/[0.07] font-medium text-red"
                              : "text-ink/70 hover:bg-black/[0.04] hover:text-ink",
                          )}
                        >
                          {inner}
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <button
        onClick={onToggle}
        className="flex h-11 items-center gap-2.5 border-t border-black/[0.06] px-4 text-xs text-ink/50 transition-colors hover:bg-black/[0.03] hover:text-ink"
      >
        {/* Logical icon: the panel sits on the reading-start side in both dirs. */}
        {collapsed ? (
          <PanelLeftOpen className="h-4 w-4 shrink-0 rtl:rotate-180" strokeWidth={1.75} />
        ) : (
          <PanelLeftClose className="h-4 w-4 shrink-0 rtl:rotate-180" strokeWidth={1.75} />
        )}
      </button>
    </aside>
  );
}
