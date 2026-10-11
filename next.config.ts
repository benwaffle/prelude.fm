import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Lets a page say which build it is, so a phone running an old copy shows.
  env: { NEXT_PUBLIC_BUILD: process.env.VERCEL_GIT_COMMIT_SHA ?? 'local' },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'i.scdn.co',
      },
    ],
  },
  // A cached worker would keep serving yesterday's rules; browsers must always
  // re-check it.
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],
      },
    ];
  },
};

export default nextConfig;
