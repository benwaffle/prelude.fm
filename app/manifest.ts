import type { MetadataRoute } from 'next';

/** Colours are the ivory paper so the splash screen matches the first screen. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'prelude.fm',
    short_name: 'prelude.fm',
    description: 'Classical music streaming optimized for works and movements',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f6f1e6',
    theme_color: '#f6f1e6',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
