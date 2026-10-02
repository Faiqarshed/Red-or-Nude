import localFont from "next/font/local";

// Figma font: "DG Agnadeen", the site's display and body face, used by the
// admin's headings too. Self-hosted (OFL, public/fonts/DGAgnadeen-OFL.txt).
//
// Through next/font rather than a hand-written @font-face: Next preloads the
// files with the page and gives the fallback DG Agnadeen's measurements. The
// plain @font-face loaded late and swapped in over Almarai, whose letters are
// smaller, so every reload drew the page small and then grew it.
export const agnadeen = localFont({
  src: [
    { path: "../public/fonts/DGAgnadeen-Thin.ttf", weight: "100" },
    { path: "../public/fonts/DGAgnadeen-Ultralight.ttf", weight: "200" },
    { path: "../public/fonts/DGAgnadeen-Light.ttf", weight: "300" },
    { path: "../public/fonts/DGAgnadeen-Regular.ttf", weight: "400 600" },
    { path: "../public/fonts/DGAgnadeen-Bold.ttf", weight: "700" },
    { path: "../public/fonts/DGAgnadeen-Extrabold.ttf", weight: "800" },
    { path: "../public/fonts/DGAgnadeen-Heavy.ttf", weight: "900" },
  ],
  variable: "--font-agnadeen",
  display: "swap",
});
