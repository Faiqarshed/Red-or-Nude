import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    // lib/ too, or a class name that lives in a helper rather than in the JSX
    // is silently never generated. Nothing errors — the element just renders
    // with no styling at all, which is indistinguishable from the styling being
    // wrong, and cost an afternoon on the booking status colours.
    "./lib/**/*.{js,ts}",
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
        // she catches out of the corner of her eye.
        //
        // All three breathe between two strengths of one colour rather than
        // fading out to nothing, so the state is readable at every instant —
        // resting at white meant half of every cycle said nothing at all.
        //
        // Three colours, three meanings: red is "somebody is waiting on you" on
        // the technician's own screen, yellow is the same fact reported to the
        // desk, green is "on the clock".
        "waiting-pulse": {
          "0%, 100%": { backgroundColor: "#fdeaea", borderColor: "rgba(184,0,7,0.30)" },
          "50%": { backgroundColor: "#f8cdcd", borderColor: "#B80007" },
        },
        "running-pulse": {
          "0%, 100%": { backgroundColor: "#e9f5ee", borderColor: "rgba(31,122,77,0.30)" },
          "50%": { backgroundColor: "#c7e6d4", borderColor: "#1f7a4d" },
        },
        "row-checkin": {
          "0%, 100%": { backgroundColor: "#fdf6e7", borderColor: "rgba(183,121,31,0.35)" },
          "50%": { backgroundColor: "#f6e2ae", borderColor: "#b7791f" },
        },
      },
      animation: {
        // Slow enough to read as breathing rather than an alarm — this runs for
        // as long as the customer is sitting there, and a fast blink would have
        // the salon turning the screen face-down by lunchtime.
        // Waiting breathes faster than working: the first is a queue the desk
        // can shorten, the second is just time passing.
        "waiting-pulse": "waiting-pulse 1.8s ease-in-out infinite",
        "running-pulse": "running-pulse 2.6s ease-in-out infinite",
        "row-checkin": "row-checkin 1.8s ease-in-out infinite",
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
