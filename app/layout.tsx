import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';

const mackinac = localFont({
  src: [
    {
      path: './fonts/mackinac-medium.woff2',
      weight: '400',
      style: 'normal',
    },
    {
      path: './fonts/mackinac-medium-italic.woff2',
      weight: '400',
      style: 'italic',
    },
    {
      path: './fonts/mackinac-bold.woff2',
      weight: '700',
      style: 'normal',
    },
    {
      path: './fonts/mackinac-bold-italic.woff2',
      weight: '700',
      style: 'italic',
    },
  ],
  variable: '--font-mackinac',
});

export const metadata: Metadata = {
  title: 'prelude.fm',
  description: 'Classical music streaming optimized for works and movements',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${mackinac.variable} font-sans antialiased min-h-screen`}
        style={{ background: 'var(--background)', color: 'var(--foreground)' }}
      >
        {children}
      </body>
    </html>
  );
}
