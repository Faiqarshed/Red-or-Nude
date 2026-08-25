"use client";

import Link from "next/link";
import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { useAccount } from "@/lib/account/context";

export default function SiteHeader() {
  const { c, dir, toggle } = useI18n();
  const signedIn = useAccount();
  const [open, setOpen] = useState(false);

  /**
   * Signed in, Profile *replaces* Bookings rather than joining it: /account is a
   * superset of /my-bookings — the same appointments with the same actions, plus
   * the wallet, and without the reference-and-code gate a signed-in customer has
   * no reason to pass. Two entries to the same appointments would just be two
   * entries to the same appointments.
   *
   * Matched on href, not on index, so reordering the nav in the dictionary
   * doesn't silently swap the wrong link.
   */
  const nav = signedIn
    ? c.nav.map((l) => (l.href === "/my-bookings" ? { label: c.account.profile, href: "/account" } : l))
    : c.nav;

  // No account pill beside the language toggle, in either state. Signed in it
  // duplicated the Profile nav entry above; signed out it put a second red pill
  // next to the language one and made the header look like a login screen.
  // Getting to an account is the nav's job — /my-bookings offers it to guests.

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-white/60 bg-white/10 backdrop-blur-[14px] backdrop-saturate-[1.8] backdrop-brightness-[1.08] shadow-[0_10px_35px_rgba(184,0,7,0.07)]">
      {/* glossy glass sheen: brighter along the top, fading down */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/45 via-white/10 to-white/5"
      />
      {/* crisp highlight line along the very top edge (glass rim) */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/70" />
      {/* soft pink glow behind the actions (always right) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-[26%] bg-gradient-to-l from-[rgba(255,220,220,0.5)] to-transparent"
      />
      {/* Forced LTR so logo stays left / actions stay right in both languages. */}
      <div
        dir="ltr"
        className="relative mx-auto flex h-[72px] max-w-page items-center justify-between px-5 md:h-[92px] md:px-12 lg:px-16"
      >
        {/* Logo (always left) — red RON wordmark */}
        <Link href="/" aria-label="Red Or Nude">
          <img src="/logo-red.svg" alt="Red Or Nude" className="h-8 w-auto md:h-10" />
        </Link>

        {/* Nav links (center, desktop only) — order follows the language */}
        <nav dir={dir} className="hidden items-center gap-8 lg:flex">
          {nav.map((l) => (
            <Link
              key={l.label}
              href={l.href}
              className="text-[15px] font-light text-red transition-opacity hover:opacity-70"
            >
              {l.label}
            </Link>
          ))}
        </nav>

        {/* Desktop actions (always right).
            Cart, wishlist and search were buttons with no handler — nothing to
            add to, nothing to favourite, nothing to search. Removed until there
            is; the icons are still in components/icons.tsx. */}
        <div dir="rtl" className="hidden items-center gap-5 lg:flex lg:gap-7">
          <button
            dir="ltr"
            onClick={toggle}
            className="rounded-full border-[1.5px] border-red px-6 py-1.5 font-serif text-lg italic text-red transition-colors hover:bg-red hover:text-white"
          >
            {c.header.otherLang}
          </button>
        </div>

        {/* Mobile: hamburger toggle (right) */}
        <button
          aria-label={c.header.menu}
          onClick={() => setOpen((v) => !v)}
          className="flex flex-col items-center justify-center gap-[5px] text-red lg:hidden"
        >
          <span className={`block h-[2px] w-6 bg-red transition-transform ${open ? "translate-y-[7px] rotate-45" : ""}`} />
          <span className={`block h-[2px] w-6 bg-red transition-opacity ${open ? "opacity-0" : ""}`} />
          <span className={`block h-[2px] w-6 bg-red transition-transform ${open ? "-translate-y-[7px] -rotate-45" : ""}`} />
        </button>
      </div>

      {/* Mobile dropdown panel */}
      {open && (
        <div dir={dir} className="relative border-t border-red/10 bg-cream/95 px-6 py-6 backdrop-blur-md lg:hidden">
          <nav className="flex flex-col items-start gap-4 text-start">
            {nav.map((l) => (
              <Link
                key={l.label}
                href={l.href}
                onClick={() => setOpen(false)}
                className="font-display text-lg text-red transition-opacity hover:opacity-70"
              >
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="mt-6 flex items-center justify-end gap-6 border-t border-red/10 pt-5 text-red">
            <button
              dir="ltr"
              onClick={toggle}
              className="rounded-full border-[1.5px] border-red px-5 py-1.5 font-serif italic text-red transition-colors hover:bg-red hover:text-white"
            >
              {c.header.otherLang}
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
