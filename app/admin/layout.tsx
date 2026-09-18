import type { Metadata } from 'next';
import { Archivo, Archivo_Narrow, Fragment_Mono } from 'next/font/google';
import './admin.css';

/*
 * The desk keeps its own surface. The listening screens are a concert
 * programme — Garamond on ivory, generous margins, made for reading. This is
 * the workbench behind them, and it is set like the apparatus of a thematic
 * catalogue: condensed labels, a typewriter face for every identifier, and
 * room for as many rows as will fit.
 */
const archivo = Archivo({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-archivo',
});
const archivoNarrow = Archivo_Narrow({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-archivo-narrow',
});
const fragment = Fragment_Mono({
  subsets: ['latin'],
  weight: ['400'],
  variable: '--font-fragment',
});

export const metadata: Metadata = {
  title: 'catalogue desk',
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`desk ${archivo.variable} ${archivoNarrow.variable} ${fragment.variable}`}>
      {children}
    </div>
  );
}
