import type { NextConfig } from "next";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const withBundleAnalyzer = require("@next/bundle-analyzer")({
  enabled: process.env.ANALYZE === "true",
});

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  compiler: {
    removeConsole: {
      exclude: ["error", "warn"],
    },
    reactRemoveProperties: true,
  },
  async headers() {
    return [
      {
        source: "/:all*(svg|jpg|jpeg|png|gif|webp|avif|ico|txt)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
  modularizeImports: {
    "date-fns": {
      transform: "date-fns/{{member}}",
    },
    lodash: {
      transform: "lodash/{{member}}",
    },
  },
  experimental: {
    optimizePackageImports: [
      "react",
      "react-dom",
      "lucide-react",
      "@radix-ui/react-select",
      "@radix-ui/react-slider",
      "@radix-ui/react-label",
      "@radix-ui/react-tabs",
    ],
  },
};

export default withBundleAnalyzer(nextConfig);
