import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Deployed functions only ever reach Turso over the network, so they get the
  // HTTP-only client. The default client loads libSQL's native binaries (about
  // 20 MB for glibc and musl) into every function so it can open local files,
  // which only tests and scripts do, and they run outside Next with the default.
  // Next leaves @libsql/client unbundled unless it is transpiled, and an
  // unbundled import ignores the alias.
  transpilePackages: ['@libsql/client'],
  turbopack: {
    resolveAlias: { '@libsql/client': '@libsql/client/web' },
  },
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
