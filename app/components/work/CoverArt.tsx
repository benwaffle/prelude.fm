'use client';

import { useState, type ReactNode } from 'react';
import { initialsOf, type LibraryWork } from '@/lib/prelude';

/**
 * Album art, or `children` when there is none or the image fails to load.
 * Spotify serves already-sized art, so this is a plain <img>.
 */
export function CoverArt({
  src,
  alt,
  className,
  children,
}: {
  src: string | null;
  alt: string;
  className?: string;
  /** The stand-in, drawn where the art would be. */
  children: ReactNode;
}) {
  // Keyed by the source, so a new cover gets its own chance to load.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src || failedSrc === src) return <>{children}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- Spotify serves already-sized art
    <img src={src} alt={alt} onError={() => setFailedSrc(src)} className={className} />
  );
}

/**
 * The typographic plate a work shows in place of missing art: the
 * composer's initials (none when the composer is unknown) over the
 * catalogue number, era or album — whichever we actually have.
 */
export function WorkPlate({
  work,
  size,
}: {
  work: Pick<LibraryWork, 'composerFull' | 'catalog' | 'era' | 'album' | 'tint'>;
  size: 'card' | 'hero';
}) {
  return (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-[6px] bg-paper-2 p-3 text-center">
      <span
        className="absolute inset-0 opacity-[0.16]"
        style={{ background: work.tint }}
        aria-hidden
      />
      {work.composerFull && (
        <span
          className={`relative font-display leading-none font-medium text-ink-2 ${
            size === 'hero' ? 'text-[56px]' : 'text-[40px] max-[900px]:text-[26px]'
          }`}
        >
          {initialsOf(work.composerFull)}
        </span>
      )}
      <span
        className={`relative font-meta tracking-[0.18em] text-muted uppercase ${
          size === 'hero' ? 'text-[10px]' : 'text-[9px] max-[900px]:text-[7.5px]'
        }`}
      >
        {work.catalog ?? work.era ?? work.album}
      </span>
    </span>
  );
}
