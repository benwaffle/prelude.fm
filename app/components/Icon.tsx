import type { ReactElement } from 'react';

/** The prototype's icon set, drawn on a 24×24 grid. */
const PATHS: Record<string, ReactElement> = {
  search: (
    <path
      d="M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm8 2l-4.5-4.5"
      stroke="currentColor"
      strokeWidth="1.6"
      fill="none"
      strokeLinecap="round"
    />
  ),
  play: <path d="M6 4l14 8-14 8z" fill="currentColor" />,
  pause: (
    <g fill="currentColor">
      <rect x="5" y="4" width="5" height="16" rx="1" />
      <rect x="14" y="4" width="5" height="16" rx="1" />
    </g>
  ),
  prev: (
    <g fill="currentColor">
      <rect x="4" y="5" width="2" height="14" />
      <path d="M20 5L8 12l12 7z" />
    </g>
  ),
  next: (
    <g fill="currentColor">
      <path d="M4 5l12 7L4 19z" />
      <rect x="18" y="5" width="2" height="14" />
    </g>
  ),
  vol: (
    <path
      d="M4 9v6h3l5 4V5l-5 4H4zm12 3a3 3 0 0 0-2-2.8v5.6A3 3 0 0 0 16 12zm-2-7v1.8a5 5 0 0 1 0 10.4V20a7 7 0 0 0 0-15z"
      fill="currentColor"
    />
  ),
  mute: (
    <path
      d="M4 9v6h3l5 4V5l-5 4H4zm11.5 1.1l1.4-1.4 1.6 1.6 1.6-1.6 1.4 1.4L19.9 12l1.6 1.6-1.4 1.4-1.6-1.6-1.6 1.6-1.4-1.4L17.1 12z"
      fill="currentColor"
    />
  ),
  queue: (
    <g stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round">
      <path d="M3 6h14M3 12h14M3 18h10" />
    </g>
  ),
  queueAdd: (
    <g stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round">
      <path d="M3 6h12M3 12h12M3 18h7M18 14v8M14 18h8" />
    </g>
  ),
  check: (
    <path
      d="M4 12.5l5 5L20 6.5"
      stroke="currentColor"
      strokeWidth="1.6"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  heartFill: (
    <path
      d="M12 21s-7-4.35-9.5-8.5C.5 9 2.5 4 6.5 4c2 0 3.5 1 5.5 3.5C14 5 15.5 4 17.5 4 21.5 4 23.5 9 21.5 12.5 19 16.65 12 21 12 21z"
      fill="currentColor"
    />
  ),
  heartOutline: (
    <path
      d="M12 21s-7-4.35-9.5-8.5C.5 9 2.5 4 6.5 4c2 0 3.5 1 5.5 3.5C14 5 15.5 4 17.5 4 21.5 4 23.5 9 21.5 12.5 19 16.65 12 21 12 21z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    />
  ),
  devices: (
    <g stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round">
      <rect x="3" y="3" width="11" height="18" rx="1.5" />
      <circle cx="8.5" cy="14.5" r="2.75" />
      <circle cx="8.5" cy="7.25" r="0.6" fill="currentColor" />
      <rect x="17" y="8" width="4.5" height="13" rx="1" />
    </g>
  ),
  close: (
    <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  ),
  back: (
    <path
      d="M15 5l-7 7 7 7"
      stroke="currentColor"
      strokeWidth="1.6"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="block" aria-hidden>
      {PATHS[name]}
    </svg>
  );
}

/** The five-bar equaliser that marks the movement currently playing. */
export function Waveform({ bars = 4, className = '' }: { bars?: number; className?: string }) {
  const heights = ['40%', '80%', '55%', '95%', '35%'];
  return (
    <span className={`inline-flex h-[10px] items-end gap-[2px] ${className}`} aria-hidden>
      {heights.slice(0, bars).map((h, i) => (
        <i
          key={i}
          className="animate-wave inline-block w-[2px] rounded-[1px] bg-accent"
          style={{ height: h, animationDelay: `${i * 120}ms` }}
        />
      ))}
    </span>
  );
}
