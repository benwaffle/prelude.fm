'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { usePlayer, usePlayerActions, type PlaybackDevice } from '@/lib/spotify-player-context';
import { useServerQuery } from '@/lib/use-server-query';
import { Icon } from './Icon';

// The bar's backdrop blur traps fixed-position children, so an overlay can't catch outside taps;
// listen on the document instead.
export function useDismiss(toggle: string, onClose: () => void): RefObject<HTMLDivElement | null> {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Element;
      if (target.closest?.(toggle)) return;
      if (panelRef.current && !panelRef.current.contains(target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Defer so the tap that opened the panel doesn't immediately close it.
    const timer = setTimeout(() => document.addEventListener('pointerdown', onPointer));
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [toggle, onClose]);
  return panelRef;
}

interface DevicePickerProps {
  onClose: () => void;
}

export function DevicePicker({ onClose }: DevicePickerProps) {
  const { devices, outputDevice, local, needsDevice } = usePlayer();
  const { refreshDevices, chooseDevice } = usePlayerActions();
  const [scan, setScan] = useState(0);
  const loading = useServerQuery(refreshDevices, [refreshDevices, scan]).status === 'loading';
  const panelRef = useDismiss('[data-device-toggle]', onClose);

  const pick = (device: PlaybackDevice) => {
    chooseDevice(device);
    onClose();
  };

  const others = devices.filter((d) => !d.isThisBrowser);

  return (
    <>
      <div
        ref={panelRef}
        role="dialog"
        aria-label="Choose where to play"
        className="absolute right-4 bottom-full z-[20] mb-2 w-[320px] animate-rise rounded-[3px] border border-rule bg-paper text-ink shadow-deep max-[900px]:right-3 max-[900px]:left-3 max-[900px]:w-auto"
      >
        <div className="flex items-baseline justify-between border-b border-rule px-4 pt-3 pb-2">
          <span className="font-meta text-[10px] tracking-[0.18em] text-muted uppercase">
            {needsDevice ? 'Where should this play?' : 'Play on'}
          </span>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="-mr-1 cursor-pointer p-1 text-muted hover:text-ink"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        <ul className="py-1">
          {local.status === 'ready' ? (
            devices
              .filter((d) => d.isThisBrowser)
              .map((d) => (
                <DeviceRow
                  key={d.id}
                  device={d}
                  caption="Plays in this tab"
                  selected={outputDevice?.id === d.id}
                  onPick={pick}
                />
              ))
          ) : (
            <li className="px-4 py-[10px] opacity-60">
              <div className="font-display text-[16px] leading-tight">This browser</div>
              <div className="font-display text-[13px] text-muted italic">
                {local.status === 'unavailable' ? local.problem : 'Still connecting to Spotify…'}
              </div>
            </li>
          )}

          {others.map((d) => (
            <DeviceRow
              key={d.id}
              device={d}
              caption={
                d.isRestricted
                  ? 'Spotify doesn’t let other apps control this device'
                  : deviceKind(d.type)
              }
              selected={outputDevice?.id === d.id}
              onPick={pick}
            />
          ))}

          {!loading && others.length === 0 && (
            <li className="px-4 py-[10px] font-display text-[14px] leading-snug text-muted italic">
              No Spotify apps or speakers are on right now. Open Spotify on your phone or speaker,
              then refresh.
            </li>
          )}
        </ul>

        <div className="flex items-center justify-between border-t border-rule px-4 py-2">
          <span className="font-display text-[12.5px] text-muted italic">
            {loading ? 'Looking for devices…' : ''}
          </span>
          <button
            type="button"
            onClick={() => setScan((n) => n + 1)}
            disabled={loading}
            className="cursor-pointer font-meta text-[10px] tracking-[0.16em] text-ink-2 uppercase hover:text-ink disabled:cursor-default disabled:opacity-40"
          >
            Refresh
          </button>
        </div>
      </div>
    </>
  );
}

function DeviceRow({
  device,
  caption,
  selected,
  onPick,
}: {
  device: PlaybackDevice;
  caption: string;
  selected: boolean;
  onPick: (device: PlaybackDevice) => void;
}) {
  return (
    <li>
      <button
        type="button"
        disabled={device.isRestricted}
        onClick={() => onPick(device)}
        className="flex w-full cursor-pointer items-center gap-3 px-4 py-[10px] text-left hover:bg-paper-2 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
      >
        <span className={selected ? 'text-accent' : 'text-muted'}>
          <Icon name="devices" size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate font-display text-[16px] leading-tight ${selected ? 'text-accent' : ''}`}
          >
            {device.name}
          </span>
          <span className="block truncate font-display text-[13px] text-muted italic">
            {caption}
          </span>
        </span>
        {selected && (
          <span className="shrink-0 font-meta text-[9px] tracking-[0.16em] text-accent uppercase">
            Selected
          </span>
        )}
      </button>
    </li>
  );
}

function deviceKind(type: string): string {
  const kinds: Record<string, string> = {
    Smartphone: 'Phone',
    Computer: 'Computer',
    Tablet: 'Tablet',
    Speaker: 'Speaker',
    TV: 'TV',
    AVR: 'Receiver',
    STB: 'Set-top box',
    AudioDongle: 'Audio dongle',
    GameConsole: 'Game console',
    CastVideo: 'Chromecast',
    CastAudio: 'Chromecast audio',
    Automobile: 'Car',
  };
  return kinds[type] ?? type;
}
