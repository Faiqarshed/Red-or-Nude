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
            sits on the left and the newsletter on the right. */}
        <div
          dir="ltr"
          className={`flex flex-col items-stretch gap-12 lg:items-start lg:justify-between lg:gap-16 ${
            lang === "ar" ? "lg:flex-row" : "lg:flex-row-reverse"
          }`}
        >
          {/* Subscribe form */}
          <div dir={dir} className="order-4 w-full text-start lg:order-1 lg:max-w-[560px] lg:flex-1">
            <h3 className="mb-6 font-display text-base font-bold text-red">{f.subscribeTitle}</h3>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <input
                  type="text"
                  placeholder={f.firstName}
                  className="h-[58px] rounded-[16px] border border-red/30 bg-transparent px-5 text-start font-display text-base text-red outline-none placeholder:text-red/50 focus:border-red/60"
                />
                <input
                  type="text"
                  placeholder={f.lastName}
                  className="h-[58px] rounded-[16px] border border-red/30 bg-transparent px-5 text-start font-display text-base text-red outline-none placeholder:text-red/50 focus:border-red/60"
                />
              </div>
              <input
                type="email"
                placeholder={f.email}
                className="h-[58px] w-full rounded-[16px] border border-red/30 bg-transparent px-5 text-start font-display text-base text-red outline-none placeholder:text-red/50 focus:border-red/60"
              />
              <button className="h-[52px] w-full rounded-[16px] bg-red font-display text-base font-bold text-white transition-opacity hover:opacity-90">
                {f.subscribe}
              </button>
            </div>
            <div className="mt-6 flex justify-start gap-4">
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
              {f.aboutLinks.map((l) => (
                <li key={l}>
                  <a href="#" className="whitespace-nowrap transition-colors hover:text-red">
                    {l}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Find-an-answer column */}
          <div dir={dir} className="order-2 text-start lg:order-3">
            <h4 className="mb-6 font-display text-base font-bold text-red">{f.answerTitle}</h4>
            <ul className="space-y-3 font-display text-[15px] text-red/50">
              {f.answerLinks.map((l) => (
                <li key={l}>
                  <a href="#" className="whitespace-nowrap transition-colors hover:text-red">
                    {l}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Big RON logo */}
          <div className="order-1 flex justify-start lg:order-4">
            <img src="/logo-red.svg" alt="Red Or Nude" className="h-[88px] w-auto md:h-[118px]" />
          </div>
        </div>

        {/* Bottom bar — copyright left, policy links right */}
        <div
          dir="ltr"
          className="mt-14 flex flex-col items-center justify-between gap-4 border-t border-red pt-6 font-display text-sm text-red md:flex-row"
        >
          <p>{f.copyright}</p>
          <div dir={dir} className="flex gap-10">
            <a href="#" className="hover:opacity-70">{f.privacy}</a>
            <a href="#" className="hover:opacity-70">{f.cookies}</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
