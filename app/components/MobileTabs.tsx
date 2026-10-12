'use client';

import Link from 'next/link';

const TABS = [
  { label: 'Library', href: '/', key: 'library' },
  { label: 'Catalogue', href: '/catalog', key: 'catalogue' },
] as const;

export function MobileTabs({ current }: { current: 'library' | 'catalogue' }) {
  return (
    <nav className="hidden border-t border-rule bg-paper pb-[env(safe-area-inset-bottom)] select-none max-[900px]:flex">
      {TABS.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={current === tab.key ? 'page' : undefined}
          className={`flex h-12 flex-1 items-center justify-center font-meta text-[10.5px] tracking-[0.18em] uppercase no-underline ${
            current === tab.key ? 'text-ink' : 'text-muted'
          }`}
        >
          <span
            className={`border-b pb-[3px] ${current === tab.key ? 'border-accent' : 'border-transparent'}`}
          >
            {tab.label}
          </span>
        </Link>
      ))}
    </nav>
  );
}
