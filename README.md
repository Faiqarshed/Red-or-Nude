# Red Or Nude — Frontend

Frontend replica of the **Red Or Nude** Figma design, built with **Next.js (App Router)** + **Tailwind CSS**, RTL Arabic. Layout, colors, sizes, and text are taken directly from the Figma file via the Figma design API.

## Run

```bash
npm install
npm run dev            # http://localhost:3000
```

## Real assets (images)

Images render from `/public` with the exact filenames the app expects. To pull the
real images straight from Figma, run the fetch script with your Figma token
(the token stays on your machine — it is only read from the environment):

```bash
FIGMA_TOKEN=your_token node scripts/fetch-assets.mjs
```

Get a token at Figma → Settings → Security → Personal access tokens. Until the
assets are present, every image degrades gracefully (colored placeholder / gradient).

Expected files: `hero-hands.png`, `map-riyadh.png`, `eid-offers.png`,
`service-1.png … service-4.png`.

## Fonts

The Figma fonts are **DG Agnadeen** (display) and **Lama Sans** (body) — licensed
fonts, not on Google Fonts. Drop the `.woff2` files into `/public/fonts` (see the
`@font-face` names in `app/globals.css`) and they load automatically. Without them,
the app falls back to **Cairo**.

## Design tokens (read from Figma)

- Background: `#FFFAF0` (cream)
- Brand red: `#B80007` → `#520003` (gradient)
- Text: `#181717`
- Blue accent: `#69A7C4`
- Card radius: `36px`

## Status

- [x] Foundation (RTL, fonts, palette, Tailwind tokens)
- [x] Screen 1 — Landing page: header, hero, booking cards, marquee, branch map, Eid offers, services, footer
- [ ] Remaining desktop screens
- [ ] Mobile responsive breakpoints

## Structure

```
app/           layout.tsx (RTL + fonts) · page.tsx (landing) · globals.css
components/    SiteHeader · SiteFooter · Marquee · Logo · icons
  sections/    Hero · BranchMap · Offers · Services
scripts/       fetch-assets.mjs   (pull real images from Figma)
```
