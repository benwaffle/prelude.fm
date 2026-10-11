import type { Metadata, Viewport } from 'next';
import { Analytics } from '@vercel/analytics/next';
import { Cormorant_Garamond, Inter } from 'next/font/google';
import { ServiceWorker } from './components/ServiceWorker';
import './globals.css';

// The editorial type pairing from the design: a Garamond for display, Inter
// for body and metadata.
const cormorant = Cormorant_Garamond({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  style: ['normal', 'italic'],
  variable: '--font-cormorant',
});

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: 'prelude.fm',
  description: 'Classical music streaming optimized for works and movements',
  // Launched from the home screen, iOS runs the app full-screen under this name.
  appleWebApp: { capable: true, title: 'prelude.fm', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  // The browser chrome takes the paper colour, ivory or mahogany with the OS.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f1e6' },
    { media: '(prefers-color-scheme: dark)', color: '#141210' },
  ],
  // Lets the player bar reach under the home indicator; it pads itself back.
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-density="compact">
      <body className={`${cormorant.variable} ${inter.variable} antialiased`}>
        {children}
        <ServiceWorker />
        <Analytics />
      </body>
    </html>
  );
}
