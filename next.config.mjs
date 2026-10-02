/** @type {import('next').NextConfig} */
const nextConfig = {
  // Builds a self-contained server in .next/standalone with only the files it
  // needs, so the Azure deploy ships a ready-to-run bundle instead of building
  // on the App Service VM (.github/workflows/deploy-azure.yml). Vercel ignores it.
  output: "standalone",
};

export default nextConfig;
