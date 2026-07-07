#!/usr/bin/env node
/**
 * Downloads the real image assets for the Red Or Nude pages from Figma and
 * saves them into /public with the exact filenames the app expects.
 *
 * Usage:
 *   FIGMA_TOKEN=your_personal_access_token node scripts/fetch-assets.mjs
 *
 * Get a token: Figma → Settings → Security → Personal access tokens (File content: read-only).
 * The token stays on your machine — it is only read from the environment.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILE_KEY = "dZRgYKjbTsisuCVpOTOtnX";
const TOKEN = process.env.FIGMA_TOKEN;

// 1) Nodes that render cleanly via the image-render API  (node id -> filename)
const RENDER = {
  "108:4370": "hero-hands.png",
  "138:256": "map-riyadh.png",
  "108:4307": "eid-offers.png",
  "108:4087": "wordmark.png", // RED OR NUDE outlined wordmark (vector)
};

// 2) Photos/textures that live as image *fills*.
//    We read the node's fills (in document order) and download them.
const FILL_SOURCES = [
  { node: "180:261", files: ["service-1.png", "service-2.png", "service-3.png", "service-4.png"] },
  { node: "108:4083", files: ["bg-texture.png"] }, // full-page paper texture
];

if (!TOKEN) {
  console.error("Missing FIGMA_TOKEN. Run: FIGMA_TOKEN=xxxx node scripts/fetch-assets.mjs");
  process.exit(1);
}

const headers = { "X-Figma-Token": TOKEN };
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const api = async (path) => {
  const res = await fetch(`https://api.figma.com${path}`, { headers });
  if (!res.ok) throw new Error(`Figma API ${res.status}: ${await res.text()}`);
  return res.json();
};

const save = async (url, file) => {
  const r = await fetch(url);
  const buf = Buffer.from(await r.arrayBuffer());
  await writeFile(join(publicDir, file), buf);
  console.log(`✓ ${file}  (${(buf.length / 1024).toFixed(0)} KB)`);
};

// Collect the imageRef of every IMAGE fill in a node subtree, in document order.
function collectImageRefs(node, out = []) {
  if (Array.isArray(node.fills)) {
    for (const f of node.fills) {
      if (f.type === "IMAGE" && f.imageRef) out.push(f.imageRef);
    }
  }
  if (Array.isArray(node.children)) for (const c of node.children) collectImageRefs(c, out);
  return out;
}

async function main() {
  await mkdir(publicDir, { recursive: true });

  // 1) Rendered nodes
  const ids = Object.keys(RENDER);
  const { images } = await api(
    `/v1/images/${FILE_KEY}?ids=${encodeURIComponent(ids.join(","))}&format=png&scale=2`,
  );
  for (const [id, file] of Object.entries(RENDER)) {
    if (images[id]) await save(images[id], file);
    else console.warn(`⚠  no render for ${id} (${file})`);
  }

  // 2) Image fills
  const fillMap = (await api(`/v1/files/${FILE_KEY}/images`)).meta.images; // imageRef -> url
  for (const { node, files } of FILL_SOURCES) {
    const doc = await api(`/v1/files/${FILE_KEY}/nodes?ids=${encodeURIComponent(node)}`);
    const root = doc.nodes[node]?.document;
    const refs = root ? collectImageRefs(root) : [];
    for (let i = 0; i < files.length; i++) {
      const url = refs[i] && fillMap[refs[i]];
      if (url) await save(url, files[i]);
      else console.warn(`⚠  no fill found for ${files[i]}`);
    }
  }

  console.log("\nDone. Assets saved to /public.");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
