import { InstagramIcon, FacebookIcon, LinkedInIcon, TiktokIcon } from "./icons";

// Exact copy from Figma (Container 108:4245). All text is brand red; the panel
// is a warm tint with large rounded top corners.
const answerLinks = ["الأسئلة الشائعة", "تواصلي معنا", "الشروط والأحكام", "سياسة الخصوصية"];
const aboutLinks = ["مواقعنا", "وظائف"];
const socials = [InstagramIcon, FacebookIcon, LinkedInIcon, TiktokIcon];

export default function SiteFooter() {
  return (
    <footer className="mt-[10vh] rounded-t-[110px] bg-[rgba(197,146,97,0.14)]">
      <div className="mx-auto max-w-page px-8 pb-10 pt-24 md:px-16 md:pb-12 md:pt-28">
        {/* Top: form (left) · columns · logo (right) */}
        <div
          dir="ltr"
          className="flex flex-col items-stretch gap-12 lg:flex-row lg:items-start lg:justify-between lg:gap-16"
        >
          {/* Subscribe form */}
          <div className="order-4 w-full text-right lg:order-1 lg:max-w-[560px] lg:flex-1">
            <h3 className="mb-6 font-display text-base font-bold text-red">ابقَي على تواصل</h3>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <input
                  type="text"
                  placeholder="الاسم الأول"
                  className="h-[58px] rounded-[16px] border border-red/30 bg-transparent px-5 text-right font-display text-base text-red outline-none placeholder:text-red/50 focus:border-red/60"
                />
                <input
                  type="text"
                  placeholder="اسم العائلة"
                  className="h-[58px] rounded-[16px] border border-red/30 bg-transparent px-5 text-right font-display text-base text-red outline-none placeholder:text-red/50 focus:border-red/60"
                />
              </div>
              <input
                type="email"
                placeholder="البريد الإلكتروني"
                className="h-[58px] w-full rounded-[16px] border border-red/30 bg-transparent px-5 text-right font-display text-base text-red outline-none placeholder:text-red/50 focus:border-red/60"
              />
              <button className="h-[52px] w-full rounded-[16px] bg-red font-display text-base font-bold text-white transition-opacity hover:opacity-90">
                اشترك
              </button>
            </div>
            <div className="mt-6 flex justify-end gap-4">
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

          {/* من نحن column */}
          <div className="order-3 text-right lg:order-2">
            <h4 className="mb-6 font-display text-base font-bold text-red">من نحن</h4>
            <ul className="space-y-3 font-display text-[15px] text-red/50">
              <li>
                <a href="/gift-card" className="whitespace-nowrap transition-colors hover:text-red">
                  بطاقة هدية
                </a>
              </li>
              {aboutLinks.map((l) => (
                <li key={l}>
                  <a href="#" className="whitespace-nowrap transition-colors hover:text-red">
                    {l}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* ابحث عن إجابة column */}
          <div className="order-2 text-right lg:order-3">
            <h4 className="mb-6 font-display text-base font-bold text-red">ابحث عن إجابة</h4>
            <ul className="space-y-3 font-display text-[15px] text-red/50">
              {answerLinks.map((l) => (
                <li key={l}>
                  <a href="#" className="whitespace-nowrap transition-colors hover:text-red">
                    {l}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Big RON logo (right in RTL) */}
          <div className="order-1 flex justify-end lg:order-4">
            <img src="/logo-red.svg" alt="Red Or Nude" className="h-[88px] w-auto md:h-[118px]" />
          </div>
        </div>

        {/* Bottom bar — copyright left, policy links right (matches Figma) */}
        <div
          dir="ltr"
          className="mt-14 flex flex-col items-center justify-between gap-4 border-t border-red pt-6 font-display text-sm text-red md:flex-row"
        >
          <p>© 2026 REDorNUDE. جميع الحقوق محفوظة.</p>
          <div dir="rtl" className="flex gap-10">
            <a href="#" className="hover:opacity-70">سياسة الخصوصية</a>
            <a href="#" className="hover:opacity-70">إعدادات ملفات الارتباط</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
