'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { Icon } from './Icon';

const NAV_LINKS = [
  { label: 'Library', href: '/', key: 'library' },
  { label: 'Catalogue', href: '/catalog', key: 'catalogue' },
] as const;

interface PreludeNavProps {
  current: 'library' | 'catalogue';
  query?: string;
  setQuery?: (value: string) => void;
  placeholder?: string;
}

/** The top navbar shared by every screen, with ⌘K focusing search. */
export function PreludeNav({ current, query, setQuery, placeholder }: PreludeNavProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="sticky top-0 z-[12] flex items-center gap-[18px] border-b border-rule bg-paper px-7 py-[14px] max-[900px]:gap-3 max-[900px]:px-4 max-[900px]:py-[10px]">
      <Link href="/" className="flex shrink-0 items-baseline gap-2 no-underline">
        <span className="font-display text-2xl leading-none font-medium tracking-[-0.01em] italic">
          prelude<span className="text-accent">.</span>fm
        </span>
      </Link>

      {/* Phones get these as tabs along the bottom, within thumb reach. */}
      <nav className="ml-2 flex gap-[2px] max-[900px]:hidden">
        {NAV_LINKS.map((link) => (
          <Link
            key={link.key}
            href={link.href}
            className={`border-b px-[11px] py-[6px] font-meta text-[10px] tracking-[0.16em] whitespace-nowrap uppercase no-underline transition-colors duration-150 max-[900px]:px-0 max-[900px]:pr-4 ${
              current === link.key
                ? 'border-accent text-ink'
                : 'border-transparent text-muted hover:text-ink-2'
            }`}
          >
            {link.label}
          </Link>
        ))}
      </nav>

      {setQuery && (
        <div className="relative ml-auto w-[min(340px,40vw)] shrink-0 max-[900px]:w-auto max-[900px]:flex-1">
          <span className="pointer-events-none absolute top-1/2 left-[10px] -translate-y-1/2 text-muted">
            <Icon name="search" size={13} />
          </span>
          <input
            ref={inputRef}
            value={query ?? ''}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder ?? 'Search composers, works…'}
            className="w-full rounded-[2px] border border-rule bg-paper-2 py-2 pr-3 pl-8 font-body text-[13px] text-ink outline-none transition-colors duration-150 placeholder:text-muted placeholder:italic focus:border-ink-2"
          />
          <kbd className="absolute top-1/2 right-[9px] -translate-y-1/2 rounded-[2px] border border-rule bg-paper px-[5px] py-px font-meta text-[9.5px] text-muted max-[900px]:hidden">
            ⌘K
          </kbd>
        </div>
      )}
    </div>
  );
}
