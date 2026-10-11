'use client';

import { useEffect } from 'react';

/**
 * Registers public/sw.js, which is what lets browsers offer to install the
 * app. Development skips it so a stale worker never sits between you and the
 * dev server.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.error('Service worker registration failed:', err);
    });
  }, []);
  return null;
}
