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
        cream: "#FFFAF0", // soft warm paper page background (matches bg-texture)
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
        // DG Agnadeen is the Figma font, used site-wide (body + display). It is
        // self-hosted (see globals.css @font-face); Almarai is the load/fallback face.
        ar: ["'DG Agnadeen'", "var(--font-almarai)", "sans-serif"],
        display: ["'DG Agnadeen'", "var(--font-almarai)", "sans-serif"],
        latin: ["var(--font-poppins)", "sans-serif"],
        // Admin UI face. Bilingual coverage plus real tabular numerals, so
        // prices and times align down a column in dense tables.
        ui: ["var(--font-plex-ar)", "system-ui", "sans-serif"],
      },
      keyframes: {
        // The technician is across the room with her hands busy. A static ring
        // is something she has to look for; a card that breathes is something
        // she catches out of the corner of her eye. Two colours, two meanings:
        // red is "somebody is waiting on you", green is "you are on the clock".
        "waiting-pulse": {
          "0%, 100%": { backgroundColor: "#ffffff", borderColor: "rgba(24,23,23,0.06)" },
          "50%": { backgroundColor: "#fdeaea", borderColor: "#B80007" },
        },
        "running-pulse": {
          "0%, 100%": { backgroundColor: "#ffffff", borderColor: "rgba(24,23,23,0.06)" },
          "50%": { backgroundColor: "#e9f5ee", borderColor: "#1f7a4d" },
        },
      },
      animation: {
        // Slow enough to read as breathing rather than an alarm — this runs for
        // as long as the customer is sitting there, and a fast blink would have
        // the salon turning the screen face-down by lunchtime.
        "waiting-pulse": "waiting-pulse 1.8s ease-in-out infinite",
        "running-pulse": "running-pulse 2.6s ease-in-out infinite",
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
