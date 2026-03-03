import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "platform.slack-edge.com",
        pathname: "/img/**",
      },
    ],
  },
};

export default nextConfig;
