"use client";

// Drawer and Dialog. Editing happens in a side drawer rather than a full-page
// navigation (docs/ADMIN-PANEL.md §6) so a receptionist mid-task never loses
// their place in the list behind it.

import { useEffect } from "react";
import { Loader2, Trash2, X } from "lucide-react";
import { Button } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
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

/**
 * "Are you sure?" in the panel's own look, in place of `window.confirm`. Cancel
 * takes focus, so Enter on a stray press keeps the item; Escape and the
 * backdrop also cancel. Stays open while `pending`, so a slow delete can't be
 * clicked twice or dismissed halfway.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  preview,
  confirmLabel,
  cancelLabel,
  pending = false,
  error,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  body?: string;
  /** Shown above the text: a thumbnail, a name — whatever is about to go. */
  preview?: React.ReactNode;
  /** Defaults to "Delete" ("Deleting…" while pending) and "Keep". */
  confirmLabel?: string;
  cancelLabel?: string;
  pending?: boolean;
  /** The server's refusal, kept inside the dialog rather than behind it. */
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
  /** Anything asked before confirming, such as a reason. Sits under the text. */
  children?: React.ReactNode;
}) {
  const { t } = useAdminI18n();
  const close = () => {
    if (!pending) onClose();
  };
  useEscape(open, close);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-4">
      <div className="absolute inset-0 bg-ink/30 backdrop-blur-[3px]" onClick={close} />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={body ? "confirm-body" : undefined}
        className="relative w-full max-w-sm overflow-hidden rounded-2xl bg-white p-6 text-center shadow-2xl"
      >
        {preview ?? (
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-red/[0.08] text-red">
            <Trash2 className="h-5 w-5" strokeWidth={1.75} />
          </div>
        )}
        <h2 id="confirm-title" className="mt-4 text-base font-semibold text-ink">
          {title}
        </h2>
        {body ? (
          <p id="confirm-body" className="mt-1.5 text-[13px] leading-relaxed text-ink/55">
            {body}
          </p>
        ) : null}
        {children ? <div className="mt-4 text-start">{children}</div> : null}
        {error ? (
          <p role="alert" className="mt-4 rounded-xl bg-red/[0.07] px-3 py-2 text-start text-xs text-red">
            {error}
          </p>
        ) : null}
        <div className="mt-6 grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={close} disabled={pending} autoFocus={!children}>
            {cancelLabel ?? t.common.keep}
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={pending}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {confirmLabel ?? (pending ? t.common.deleting : t.common.delete)}
          </Button>
        </div>
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
