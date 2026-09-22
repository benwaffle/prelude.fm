import type { Metadata } from 'next';
import './admin.css';

/*
 * The desk keeps its own surface. The listening screens are a concert
 * programme — Garamond on ivory, generous margins, made for reading. This is
 * the workbench behind them, and it is set like the apparatus of a thematic
 * catalogue: condensed labels, a typewriter face for every identifier, and
 * room for as many rows as will fit.
 *
 * Fonts load via CSS rather than next/font so admin builds do not hit the
 * turbopack google-font replacer that broke GitHub deploys.
 */
export const metadata: Metadata = {
  title: 'catalogue desk',
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="desk">{children}</div>;
}
