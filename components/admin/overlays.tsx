"use client";

// Drawer and Dialog. Editing happens in a side drawer rather than a full-page
// navigation (docs/ADMIN-PANEL.md §6) so a receptionist mid-task never loses
// their place in the list behind it.

import { useEffect } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Freeze the page behind the overlay.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
}

export function Drawer({
  open,
  onClose,
  title,
  footer,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
}) {
  useEscape(open, onClose);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-ink/20 backdrop-blur-[2px]" onClick={onClose} />
      {/* Sits on the reading-end side, so it opens from the left in Arabic. */}
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "relative ms-auto flex h-full w-full flex-col bg-cream shadow-2xl",
          wide ? "max-w-2xl" : "max-w-md",
        )}
      >
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-black/[0.06] bg-white px-5">
          <h2 className="truncate text-start text-sm font-semibold text-ink">{title}</h2>
          <button
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg text-ink/45 transition-colors hover:bg-black/[0.05] hover:text-ink"
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">{children}</div>

        {footer ? (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-black/[0.06] bg-white px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  footer,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  useEscape(open, onClose);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-ink/25 backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "relative flex max-h-[85vh] w-full flex-col overflow-hidden rounded-2xl bg-cream shadow-2xl",
          className ?? "max-w-3xl",
        )}
      >
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-black/[0.06] bg-white px-5">
          <h2 className="truncate text-start text-sm font-semibold text-ink">{title}</h2>
          <button
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg text-ink/45 transition-colors hover:bg-black/[0.05] hover:text-ink"
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        {footer ? (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-black/[0.06] bg-white px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
