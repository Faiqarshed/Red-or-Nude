"use client";

// The panel's navigation below `lg`, where the desktop rail is hidden.
//
// An off-canvas sheet rather than the rail at a narrower width: the rail's
// collapsed mode is 64px of icons with no labels, which is a fine trade for a
// mouse hovering tooltips and a poor one for a thumb. The sheet shows the same
// list the rail does — `SidebarNav` is shared, so neither can drift from the
// other — with labels, group headings and 48px rows.

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import { SidebarBrand, SidebarNav } from "./Sidebar";
import { useEscape } from "./overlays";
import { useAdminI18n } from "@/lib/admin/i18n";
import type { StaffRole } from "@/lib/db/schema";
import { cn } from "@/lib/cn";

export default function MobileNav({
  role,
  open,
  onClose,
}: {
  role: StaffRole;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useAdminI18n();
  const pathname = usePathname();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEscape(open, onClose);

  // A nav drawer that survives the navigation it just performed leaves her
  // looking at the menu she already finished with.
  useEffect(() => {
    onClose();
    // Only the path matters here — `onClose` is a fresh identity each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Focus moves into the sheet when it opens so the next Tab lands inside it,
  // not on the page behind.
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  return (
    <div className="lg:hidden" aria-hidden={!open}>
      {/* Both layers stay mounted so the sheet slides rather than appears, and
          both stop taking pointer events when closed — an invisible backdrop
          over the whole page would otherwise swallow every tap. */}
      <div
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-40 bg-ink/20 backdrop-blur-[2px] transition-opacity duration-200",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      <div
        id="admin-nav"
        role="dialog"
        aria-modal="true"
        aria-label={t.panel}
        className={cn(
          // `start-0` + the mirrored transform: the sheet comes in from the
          // reading-start edge, which is the right in Arabic and the left in
          // English.
          "fixed inset-y-0 start-0 z-50 flex w-[280px] max-w-[85vw] flex-col bg-white shadow-2xl",
          // `visibility` is in the transition on purpose. It is what takes the
          // closed sheet out of the tab order — without it the nav is still
          // reachable by keyboard while parked off-screen — and because the
          // property switches discretely at the far end of the duration, the
          // panel still slides out in full before it goes.
          "transition-[transform,visibility] duration-200 ease-out motion-reduce:transition-none",
          open
            ? "visible translate-x-0"
            : "invisible -translate-x-full rtl:translate-x-full",
        )}
      >
        <SidebarBrand
          action={
            <button
              ref={closeRef}
              onClick={onClose}
              aria-label={t.topbar.closeMenu}
              className="relative -me-1 ms-auto grid h-9 w-9 shrink-0 place-items-center rounded-xl text-ink/45 transition-colors after:absolute after:-inset-1.5 after:content-[''] hover:bg-black/[0.05] hover:text-ink"
            >
              <X className="h-5 w-5" strokeWidth={2} />
            </button>
          }
        />
        <SidebarNav role={role} onNavigate={onClose} />
      </div>
    </div>
  );
}
