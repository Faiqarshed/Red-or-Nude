// The gift card, rendered as a PNG so it can be shown inside an email.
//
// Email clients can't run React, and they can't reliably position text over a
// background image either — Outlook renders with Word's engine, which has no
// absolute positioning. So the card that <GiftCardArt> draws in the browser has
// to become a flat image before it can be posted to anyone.
//
// Uses `next/og` (Satori), which ships with Next — no new dependency.
//
// Deliberately Latin-only content: Satori loads no Arabic font by default, so
// Arabic text would render as empty boxes. The names and the personal message
// therefore stay as real HTML text in the email around this image, which is
// better anyway — they stay translatable, selectable and readable to a screen
// reader. This image is the card's *look*: brand, badge and amount.
//
// The code is deliberately NOT drawn here. It must stay copyable text, and
// Gmail proxies and caches remote images, so a code in an image URL is a code
// sitting in a third-party cache.

import { ImageResponse } from "next/og";

export const runtime = "edge";

// Matches the card in components/gift/GiftCardArt.tsx and design-red.webp.
const RED = "#b80007";
const DEEP = "#7d0005";

export function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // Bounded the same way the purchase endpoint bounds it, so this can't be
  // used to render a card claiming an arbitrary amount.
  const raw = Number(searchParams.get("amount"));
  const amount = Number.isFinite(raw) ? Math.min(Math.max(Math.round(raw), 50), 2000) : 0;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 56,
          background: `linear-gradient(135deg, ${RED} 0%, ${DEEP} 100%)`,
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 40, fontWeight: 800, color: "#fff", letterSpacing: 2 }}>
              RED OR NUDE
            </span>
          </div>
          <span
            style={{
              fontSize: 22,
              color: "rgba(255,255,255,0.85)",
              border: "1px solid rgba(255,255,255,0.35)",
              borderRadius: 999,
              padding: "8px 22px",
            }}
          >
            GIFT CARD
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "flex-end", gap: 16 }}>
          <span style={{ fontSize: 130, fontWeight: 800, color: "#fff", lineHeight: 1 }}>
            {amount}
          </span>
          <span style={{ fontSize: 40, fontWeight: 600, color: "rgba(255,255,255,0.8)", paddingBottom: 14 }}>
            SAR
          </span>
        </div>
      </div>
    ),
    // 2x the 600px email body width, so it stays sharp on a retina screen.
    { width: 1200, height: 660 },
  );
}
