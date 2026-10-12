'use client';

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

// A title too long for its room scrolls to its end and back. Measured on resize only; the motion
// is a CSS animation, so nothing re-renders while it plays.
export function Marquee({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  useLayoutEffect(() => {
    const measure = () =>
      setOverflow(Math.max(0, inner.current!.offsetWidth - outer.current!.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(outer.current!);
    observer.observe(inner.current!);
    return () => observer.disconnect();
  }, []);

  const style =
    overflow > 0
      ? ({
          '--marquee-shift': `-${overflow}px`,
          animationDuration: `${4 + overflow / 25}s`,
        } as CSSProperties)
      : undefined;
  return (
    <span ref={outer} className="block min-w-0 overflow-hidden">
      <span
        ref={inner}
        className={`inline-block whitespace-nowrap ${overflow > 0 ? 'motion-safe:animate-marquee' : ''}`}
        style={style}
      >
        {children}
      </span>
    </span>
  );
}
