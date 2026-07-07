import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Design tokens read from the Figma file (Red Or Nude)
        cream: "#FFFAF0", // page background
        red: {
          DEFAULT: "#B80007", // brand red (gradient start)
          dark: "#520003", // brand red (gradient end)
        },
        ink: "#181717", // dark text
        sky: "#69A7C4", // blue accent (buttons / outlines)
      },
      backgroundImage: {
        "red-grad": "linear-gradient(180deg, #B80007 0%, #520003 100%)",
      },
      fontFamily: {
        // DG Agnadeen (display) + Lama Sans (body) are the Figma fonts; Almarai /
        // Tajawal are close free fallbacks until the licensed files are added to /public/fonts.
        ar: ["'Lama Sans'", "var(--font-tajawal)", "sans-serif"],
        display: ["'DG Agnadeen'", "var(--font-almarai)", "sans-serif"],
        latin: ["var(--font-poppins)", "sans-serif"],
      },
      borderRadius: {
        card: "36px",
      },
      maxWidth: {
        page: "1920px",
      },
    },
  },
  plugins: [],
};

export default config;
