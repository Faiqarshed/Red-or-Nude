"use client";

import { useEffect } from "react";
import { useI18n } from "@/lib/i18n";

// Centered pop-up shell used across the booking flow (Figma 439:11053 POP UP,
// 264:302 removal, 235:758 scheduler). Dimmed, blurred backdrop + white card
// with an optional right-aligned title and a close (×) button on the left.
export default function Modal({
  title,
  onClose,
  children,
  className = "",
}: {
  title?: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const { dir, c } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/30 px-4 py-8 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        dir={dir}
        onClick={(e) => e.stopPropagation()}
        className={`max-h-[90vh] w-full overflow-y-auto rounded-[24px] bg-white p-6 shadow-[0_40px_100px_rgba(0,0,0,0.25)] md:p-8 ${className}`}
      >
        <div className="mb-5 flex items-center justify-between">
          <button
            type="button"
            aria-label={c.modals.close}
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-full text-ink/50 transition-colors hover:bg-black/[0.05] hover:text-ink"
          >
            <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
          {title && <h3 className="font-display text-2xl font-extrabold text-ink">{title}</h3>}
        </div>
        {children}
      </div>
    </div>
  );
}
