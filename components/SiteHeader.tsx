"use client";

import Link from "next/link";
import { useState } from "react";
import { SearchIcon, HeartIcon, CartIcon } from "./icons";

const navLinks = [
  { label: "من نحن", href: "/about" },
  { label: "خدماتنا", href: "/booking" },
  { label: "اختاري الفرع", href: "/#branches" },
  { label: "تسوقي", href: "/shop" },
];

export default function SiteHeader() {
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
      {/* soft pink glow behind the actions (right side), like the reference */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-[26%] bg-gradient-to-l from-[rgba(255,220,220,0.5)] to-transparent"
      />
      <div className="relative mx-auto flex h-[72px] max-w-page items-center justify-between px-5 md:h-[92px] md:px-12 lg:px-16">
        {/* Desktop actions (right group). English far-right, then cart, heart, search */}
        <div className="hidden items-center gap-5 lg:flex lg:gap-7">
          <button
            dir="ltr"
            className="order-1 rounded-full border-[1.5px] border-red px-6 py-1.5 font-serif text-lg italic text-red transition-colors hover:bg-red hover:text-white"
          >
            English
          </button>
          <button aria-label="السلة" className="order-2 text-red transition-opacity hover:opacity-70">
            <CartIcon />
          </button>
          <button aria-label="المفضلة" className="order-3 text-red transition-opacity hover:opacity-70">
            <HeartIcon />
          </button>
          <button aria-label="بحث" className="order-4 text-red transition-opacity hover:opacity-70">
            <SearchIcon />
          </button>
        </div>

        {/* Mobile: hamburger toggle */}
        <button
          aria-label="القائمة"
          onClick={() => setOpen((v) => !v)}
          className="flex flex-col items-center justify-center gap-[5px] text-red lg:hidden"
        >
          <span
            className={`block h-[2px] w-6 bg-red transition-transform ${open ? "translate-y-[7px] rotate-45" : ""}`}
          />
          <span className={`block h-[2px] w-6 bg-red transition-opacity ${open ? "opacity-0" : ""}`} />
          <span
            className={`block h-[2px] w-6 bg-red transition-transform ${open ? "-translate-y-[7px] -rotate-45" : ""}`}
          />
        </button>

        {/* Nav links (center, desktop only) */}
        <nav className="hidden items-center gap-8 lg:flex">
          {navLinks.map((l) => (
            <Link
              key={l.label}
              href={l.href}
              className="text-[15px] font-light text-red transition-opacity hover:opacity-70"
            >
              {l.label}
            </Link>
          ))}
        </nav>

        {/* Logo (renders at the left in RTL) — red RON wordmark (Figma 210:612) */}
        <Link href="/" aria-label="Red Or Nude">
          <img src="/logo-red.svg" alt="Red Or Nude" className="h-8 w-auto md:h-10" />
        </Link>
      </div>

      {/* Mobile dropdown panel */}
      {open && (
        <div className="relative border-t border-red/10 bg-cream/95 px-6 py-6 backdrop-blur-md lg:hidden">
          <nav className="flex flex-col items-end gap-4 text-right">
            {navLinks.map((l) => (
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
            <button aria-label="بحث" className="hover:opacity-70">
              <SearchIcon />
            </button>
            <button aria-label="المفضلة" className="hover:opacity-70">
              <HeartIcon />
            </button>
            <button aria-label="السلة" className="hover:opacity-70">
              <CartIcon />
            </button>
            <button
              dir="ltr"
              className="rounded-full border-[1.5px] border-red px-5 py-1.5 font-serif italic text-red transition-colors hover:bg-red hover:text-white"
            >
              English
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
