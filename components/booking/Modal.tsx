"use client";

import { useEffect } from "react";
import { useI18n } from "@/lib/i18n";

// Centered pop-up shell used across the booking flow (Figma 439:11053 POP UP,
// 264:302 removal, 235:758 scheduler). Dimmed, blurred backdrop + white card
// with an optional right-aligned title and a close (×) button on the left.
//
// `chrome={false}` drops the header row and the padding and hands the card's
// layout to the caller — for a dialog that runs a photo edge to edge, or pins a
// footer while the middle scrolls. Everything else the shell does is the same,
// which is the point: Escape, the click-outside, the held page, the cap on
// height *and the scrolling that cap implies* are decided once for every pop-up
// on the site rather than per dialog.
//
// That last one used to be the caller's, and three of four callers forgot: cap
// a dialog at the viewport without letting it scroll and a short screen — a
// phone held sideways, an error banner pushing the buttons down — hides the way
// out completely. A default that has to be remembered is a default that is
// wrong.
export default function Modal({
  title,
  onClose,
  children,
  className = "",
  chrome = true,
}: {
  title?: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  chrome?: boolean;
}) {
  const { dir, c } = useI18n();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);

    // Both elements: which one actually scrolls depends on the layout, and
    // pinning only <body> leaves the page moving under the dialog on some of
    // these screens.
    const html = document.documentElement;
    const previous = { html: html.style.overflow, body: document.body.style.overflow };
    html.style.overflow = "hidden";
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey);
      html.style.overflow = previous.html;
      document.body.style.overflow = previous.body;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      {/* Capped at the viewport and scrollable, so a long dialog scrolls inside
          the card rather than growing past the top and bottom of the screen.
          `dvh` rather than `vh` because mobile browser chrome moves.

          A caller that pins its own footer puts `min-h-0 flex-1 overflow-y-auto`
          on the middle instead; that region fills the card, so this one never
          has anything left to scroll and the two do not fight. */}
      <div
        dir={dir}
        onClick={(e) => e.stopPropagation()}
        className={`max-h-[calc(100dvh-2rem)] w-full overflow-y-auto rounded-[24px] bg-white shadow-[0_40px_100px_rgba(0,0,0,0.25)] ${
          chrome ? "p-6 md:p-8" : "flex flex-col"
        } ${className}`}
      >
        {chrome && (
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
        )}
        {children}
      </div>
    </div>
  );
}
