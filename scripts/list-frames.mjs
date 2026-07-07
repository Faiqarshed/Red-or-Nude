#!/usr/bin/env node
/**
 * Lists every top-level frame on each page of the Figma file (id, name, size,
 * position) so the screens can be built in order. Prints compact lines.
 *
 * Usage:
 *   FIGMA_TOKEN=your_token node scripts/list-frames.mjs
 */
const FILE_KEY = "dZRgYKjbTsisuCVpOTOtnX";
const TOKEN = process.env.FIGMA_TOKEN;
if (!TOKEN) {
  console.error("Missing FIGMA_TOKEN.");
  process.exit(1);
}

const res = await fetch(`https://api.figma.com/v1/files/${FILE_KEY}?depth=2`, {
  headers: { "X-Figma-Token": TOKEN },
});
if (!res.ok) {
  console.error(`Figma API ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const { document } = await res.json();

for (const page of document.children ?? []) {
  const frames = (page.children ?? []).filter((n) =>
    ["FRAME", "COMPONENT", "INSTANCE", "COMPONENT_SET"].includes(n.type),
  );
  console.log(`\n=== PAGE: ${page.name} (${page.id}) — ${frames.length} frames ===`);
  frames
    .map((f) => ({ ...f, bb: f.absoluteBoundingBox ?? {} }))
    .sort((a, b) => (a.bb.y ?? 0) - (b.bb.y ?? 0) || (a.bb.x ?? 0) - (b.bb.x ?? 0))
    .forEach((f) => {
      const { x, y, width, height } = f.bb;
      console.log(
        `${f.id}\t${Math.round(width)}x${Math.round(height)}\t(x=${Math.round(x)}, y=${Math.round(y)})\t${f.name}`,
      );
    });
}
