"use client";

import { InstagramIcon, FacebookIcon, LinkedInIcon, TiktokIcon } from "./icons";
import { useI18n } from "@/lib/i18n";

const socials = [InstagramIcon, FacebookIcon, LinkedInIcon, TiktokIcon];

export default function SiteFooter() {
  const { c, dir, lang } = useI18n();
  const f = c.footer;

  return (
    <footer className="mt-[10vh] rounded-t-[110px] bg-[rgba(197,146,97,0.14)]">
      <div className="mx-auto max-w-page px-8 pb-10 pt-24 md:px-16 md:pb-12 md:pt-28">
        {/* Top row — forced LTR grid; reversed on desktop for English so the logo
            sits on the left and the link columns on the right. */}
        <div
          dir="ltr"
          className={`flex flex-col items-stretch gap-12 lg:items-start lg:justify-between lg:gap-16 ${
            lang === "ar" ? "lg:flex-row" : "lg:flex-row-reverse"
          }`}
        >
          {/* The newsletter sign-up lived here. It had no submit handler and no
              endpoint behind it — there is a `subscribers` table but nothing
              writes to it — so it took an address and discarded it. Removed
              until it posts somewhere; the copy is still in lib/dictionary.ts.
              Socials stay: they are marks, not links, so they promise nothing. */}
          <div dir={dir} className="order-4 text-start lg:order-1">
            <div className="flex justify-start gap-4">
              {socials.map((Icon, i) => (
                <span
                  key={i}
                  className="flex h-[44px] w-[44px] items-center justify-center rounded-full bg-red text-white"
                >
                  <Icon width={18} height={18} />
                </span>
              ))}
            </div>
          </div>

          {/* About column */}
          <div dir={dir} className="order-3 text-start lg:order-2">
            <h4 className="mb-6 font-display text-base font-bold text-red">{f.aboutTitle}</h4>
            <ul className="space-y-3 font-display text-[15px] text-red/50">
              <li>
                <a href="/gift-card" className="whitespace-nowrap transition-colors hover:text-red">
                  {f.giftCard}
                </a>
              </li>
            </ul>
          </div>

          {/* The "find an answer" column (FAQ, Contact, Terms, Privacy) was four
              href="#" links. It comes back when those pages do. */}

          {/* Big RON logo */}
          <div className="order-1 flex justify-start lg:order-4">
            <img src="/logo-red.svg" alt="Red Or Nude" className="h-[88px] w-auto md:h-[118px]" />
          </div>
        </div>

        {/* Bottom bar — copyright only; the policy links had no pages. */}
        <div
          dir="ltr"
          className="mt-14 flex flex-col items-center justify-between gap-4 border-t border-red pt-6 font-display text-sm text-red md:flex-row"
        >
          <p>{f.copyright}</p>
        </div>
      </div>
    </footer>
  );
}
