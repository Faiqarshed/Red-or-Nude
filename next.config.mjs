/**
 * Image hosts.
 *
 * `mediaUrl` (lib/storage/index.ts) hands back three shapes: a path under
 * /public for the seeded catalogue ("/service-nails.webp"), a /uploads path for
 * the local dev driver, and an absolute Supabase Storage URL. next/image serves
 * the first two without being told anything; the third is remote, and next/image
 * refuses remote hosts it has not been given.
 *
 * **The database moved to Neon; Storage did not.** The four gift-card designs
 * still load from a Supabase bucket in production, so this pattern is load-
 * bearing rather than legacy. See docs/DEPLOYMENT.md — the day those four files
 * move into /public, this whole block and the driver behind it can go.
 *
 * The host is derived from SUPABASE_URL rather than hardcoded so environments
 * don't need different configs. Read at build time, like the rest of the
 * environment here.
 */
const supabaseHost = (() => {
  try {
    return process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).hostname : null;
  } catch {
    // A malformed SUPABASE_URL should not take the build down — media falls back
    // to unoptimised loading, and everything else still ships.
    return null;
  }
})();

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: supabaseHost
      ? [{ protocol: "https", hostname: supabaseHost, pathname: "/storage/v1/object/public/**" }]
      : [],
  },
};

export default nextConfig;
