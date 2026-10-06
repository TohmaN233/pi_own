import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const configDir = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(configDir, "package.json"), "utf8")) as { version: string };
let piVersion = "unknown";
try {
  const piPkgPath = join(configDir, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

const nextConfig: NextConfig = {
  // On high-core Windows hosts Next otherwise spawns one worker per logical
  // CPU for page-data collection. This workspace has heavy Pi imports in many
  // routes; 31 workers exceeded 11 GB RSS in a single build.
  experimental: { cpus: 4 },
  outputFileTracingRoot: join(configDir, "../.."),
  outputFileTracingIncludes: {
    "/*": ["../../package.json", "../../mode-packs/domain-workflows/**", "../../skills/**", "./runtime/**", "./host-plugins/**", "./node_modules/pi-caw/**", "./node_modules/pi-subagents/**", "./node_modules/@eko24ive/pi-ask/**", "./node_modules/pi-context-usage/**"],
    "/api/pdfjs/*": ["./node_modules/pdfjs-dist/build/*.min.mjs", "./node_modules/pdfjs-dist/cmaps/**", "./node_modules/pdfjs-dist/standard_fonts/**", "./node_modules/pdfjs-dist/wasm/**", "./node_modules/pdfjs-dist/iccs/**"],
  },
  turbopack: {
    root: join(configDir, "../.."),
  },
  serverExternalPackages: [
    "undici",
    "web-push",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
    // The mode extension adapter imports untrusted, selected TypeScript files
    // through Jiti. Keep Jiti's native dynamic import outside Turbopack so a
    // concrete package path remains a Node runtime concern.
    "jiti",
  ],
  // Next 16 blocks cross-origin access to dev resources by default. Allow the
  // loopback and the RFC1918 LAN ranges so the dev server stays reachable
  // from other machines on the same LAN.
  allowedDevOrigins: [
    "127.0.0.1",
    "10.*.*.*",
    // 172.16.0.0/12
    "172.16.*.*",
    "172.17.*.*",
    "172.18.*.*",
    "172.19.*.*",
    "172.20.*.*",
    "172.21.*.*",
    "172.22.*.*",
    "172.23.*.*",
    "172.24.*.*",
    "172.25.*.*",
    "172.26.*.*",
    "172.27.*.*",
    "172.28.*.*",
    "172.29.*.*",
    "172.30.*.*",
    "172.31.*.*",
    "192.168.*.*",
  ],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
  },
};

export default nextConfig;
