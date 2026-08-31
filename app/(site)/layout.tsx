import type { Metadata } from "next";
import { Almarai, Tajawal, Poppins } from "next/font/google";
import "../globals.css";
import { LanguageProvider } from "@/lib/i18n";
import { AccountProvider } from "@/lib/account/context";
import { currentCustomer } from "@/lib/account/guard";
import ChatWidget from "@/components/ChatWidget";

// Closest free fallbacks for the licensed Figma fonts:
// Almarai ≈ DG Agnadeen (geometric display), Tajawal ≈ Lama Sans (body).
const almarai = Almarai({
  subsets: ["arabic"],
  weight: ["300", "400", "700", "800"],
  variable: "--font-almarai",
  display: "swap",
});

const tajawal = Tajawal({
  subsets: ["arabic"],
  weight: ["300", "400", "500", "700"],
  variable: "--font-tajawal",
  display: "swap",
});

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["600", "700", "800", "900"],
  variable: "--font-poppins",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Red Or Nude",
  description: "Red Or Nude — beauty & booking",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Resolved once here so every SiteHeader on the site knows which button to
  // render, without any page having to think about auth. See lib/account/context.
  const customer = await currentCustomer();

  return (
    <html
      lang="ar"
      dir="rtl"
      className={`${almarai.variable} ${tajawal.variable} ${poppins.variable}`}
    >
      <body className="font-ar bg-cream text-ink">
        <LanguageProvider>
          <AccountProvider signedIn={Boolean(customer)}>
            {children}
            {/* Site only — the admin shell has its own layout and no business
                with a customer-facing assistant. */}
            <ChatWidget />
          </AccountProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
