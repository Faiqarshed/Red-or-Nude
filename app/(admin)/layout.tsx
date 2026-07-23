// Root layout for the admin half of the app. The admin owns its own <html>, so
// its language provider can drive `dir` without fighting the public site's
// LanguageProvider — the two never mount together.

import type { Metadata } from "next";
import { Almarai, IBM_Plex_Sans_Arabic } from "next/font/google";
import "../globals.css";
import { AdminLangProvider } from "@/lib/admin/i18n";

// Headings keep the brand display face; body and tables use Plex Arabic for its
// tabular numerals and bilingual coverage.
const almarai = Almarai({
  subsets: ["arabic"],
  weight: ["400", "700", "800"],
  variable: "--font-almarai",
  display: "swap",
});

const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-ar",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Red Or Nude — Admin",
  robots: { index: false, follow: false },
};

export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl" className={`${almarai.variable} ${plexArabic.variable}`}>
      <body className="bg-cream font-ui text-ink antialiased">
        <AdminLangProvider>{children}</AdminLangProvider>
      </body>
    </html>
  );
}
