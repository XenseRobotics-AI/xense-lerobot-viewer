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
   * on the host itself, so the browser's origin is this box's own address
   * (`192.168.142.201`), not `localhost`. Next.js 15 warns about that today and
   * will refuse it outright in a future major — at which point the dev server
   * would still start and still serve HTML, but every `/_next/*` chunk would
   * fail and the page would come up blank.
   *
   * The subnet wildcard is there so a DHCP lease change does not silently
   * reintroduce the problem. Dev-only: this has no effect on `next build`.
   */
  allowedDevOrigins: [
    "192.168.142.201",
    "192.168.142.*",
    "localhost",
    "127.0.0.1",
  ],
  // Avoid the 200-800ms cold-start cost of barrel-file imports for the
  // wide-surface packages we still ship.
  experimental: {
    optimizePackageImports: ["react-icons", "recharts"],
  },
  generateBuildId: () => packageJson.version,
};

export default nextConfig;
