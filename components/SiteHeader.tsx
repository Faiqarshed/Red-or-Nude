"use client";

import Link from "next/link";
import { useState } from "react";
import { SearchIcon, HeartIcon, CartIcon } from "./icons";
import { useI18n } from "@/lib/i18n";

export default function SiteHeader() {
  const { c, dir, toggle } = useI18n();
  const [open, setOpen] = useState(false);

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
          {c.nav.map((l) => (
            <Link
              key={l.label}
              href={l.href}
              className="text-[15px] font-light text-red transition-opacity hover:opacity-70"
            >
              {l.label}
            </Link>
          ))}
        </nav>

        {/* Desktop actions (always right). Toggle sits at the outer edge. */}
        <div dir="rtl" className="hidden items-center gap-5 lg:flex lg:gap-7">
          <button
            dir="ltr"
            onClick={toggle}
            className="rounded-full border-[1.5px] border-red px-6 py-1.5 font-serif text-lg italic text-red transition-colors hover:bg-red hover:text-white"
          >
            {c.header.otherLang}
          </button>
          <button aria-label={c.header.cart} className="text-red transition-opacity hover:opacity-70">
            <CartIcon />
          </button>
          <button aria-label={c.header.wishlist} className="text-red transition-opacity hover:opacity-70">
            <HeartIcon />
          </button>
          <button aria-label={c.header.search} className="text-red transition-opacity hover:opacity-70">
            <SearchIcon />
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
            {c.nav.map((l) => (
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
            <button aria-label={c.header.search} className="hover:opacity-70">
              <SearchIcon />
            </button>
            <button aria-label={c.header.wishlist} className="hover:opacity-70">
              <HeartIcon />
            </button>
            <button aria-label={c.header.cart} className="hover:opacity-70">
              <CartIcon />
            </button>
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
