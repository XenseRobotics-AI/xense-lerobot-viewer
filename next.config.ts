import type { NextConfig } from "next";
import packageJson from "./package.json";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  transpilePackages: ["three"],
  /**
   * Origins allowed to pull `/_next/*` from the dev server.
   *
   * The viewer is routinely opened from another machine on the LAN rather than
   * on the host itself, so the browser's origin is the dev box's own address,
   * not `localhost`. Next.js 15 warns about that today and will refuse it
   * outright in a future major — at which point the dev server would still
   * start and still serve HTML, but every `/_next/*` chunk would fail and the
   * page would come up blank.
   *
   * Setting this list at all already flips Next from warn to *block* for any
   * origin missing from it, so every dev box's subnet has to be listed. The
   * subnet wildcards keep a DHCP lease change from silently reintroducing the
   * problem, and DEV_ALLOWED_ORIGINS (comma-separated hostnames, `*.`
   * wildcards allowed) adds another network without a code change.
   * Dev-only: this has no effect on `next build`.
   */
  allowedDevOrigins: [
    "192.168.142.201",
    "192.168.142.*",
    "192.168.110.*",
    "localhost",
    "127.0.0.1",
    ...(process.env.DEV_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ],
  // Avoid the 200-800ms cold-start cost of barrel-file imports for the
  // wide-surface packages we still ship.
  experimental: {
    optimizePackageImports: ["react-icons", "recharts"],
  },
  generateBuildId: () => packageJson.version,
};

export default nextConfig;
