import type { Metadata } from "next";
import { Almarai, Tajawal, Poppins } from "next/font/google";
import "./globals.css";
import { LanguageProvider } from "@/lib/i18n";

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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="ar"
      dir="rtl"
      className={`${almarai.variable} ${tajawal.variable} ${poppins.variable}`}
    >
      <body className="font-ar bg-cream text-ink">
        <LanguageProvider>{children}</LanguageProvider>
      </body>
    </html>
  );
}
