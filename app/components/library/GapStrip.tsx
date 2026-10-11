'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { authClient } from '@/lib/auth-client';
import { getQueuedTrackIds, submitToMatchQueue } from '@/app/actions/spotify';
import { adminGapHref, gapRoute } from '@/app/admin/lib/gap-route';
import type { MusicBrainzGapCode, UnresolvedLibraryTrack } from '@/lib/musicbrainz-library';
import { GAP_REASONS as REASONS } from '@/lib/gap-reasons';

/**
 * Held tracks the MusicBrainz reader could not put on a card, grouped by
 * what is missing.
 *
 * Deliberately quiet, like the strip it sits beside — but it does say what
 * is wrong. "We couldn't identify this" is the answer that stops the work;
 * "MusicBrainz has no release for this album" is the one that starts it.
 */

export function GapStrip({ tracks }: { tracks: UnresolvedLibraryTrack[] }) {
  const [open, setOpen] = useState(false);
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!open || tracks.length === 0) return;
    let cancelled = false;
    getQueuedTrackIds(tracks.map((track) => track.spotifyTrackId))
      .then((ids) => {
        if (!cancelled) setQueued(new Set(ids));
      })
      .catch((error) => console.error('Failed to read match queue:', error));
    return () => {
      cancelled = true;
    };
  }, [open, tracks]);

  async function send(trackId: string) {
    setSending((current) => new Set(current).add(trackId));
    try {
      await submitToMatchQueue([trackId]);
      setQueued((current) => new Set(current).add(trackId));
    } catch (error) {
      console.error('Failed to submit track for matching:', error);
    } finally {
      setSending((current) => {
        const next = new Set(current);
        next.delete(trackId);
        return next;
      });
    }
  }
  const { data: session } = authClient.useSession();
  const isAdmin = session?.user?.name === 'benwaffle';
  if (tracks.length === 0) return null;

  const byReason = new Map<MusicBrainzGapCode, UnresolvedLibraryTrack[]>();
  for (const track of tracks) {
    // The first gap is the one that stopped it; the rest follow from it.
    const code = track.gaps[0]?.code;
    if (!code) continue;
    byReason.set(code, [...(byReason.get(code) ?? []), track]);
  }
  const groups = Array.from(byReason).sort((left, right) => right[1].length - left[1].length);

  return (
    <div className="mt-2 border-t border-rule pt-[14px]">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        className="group flex cursor-pointer items-baseline gap-[9px] font-meta text-[10px] tracking-[0.16em] text-muted uppercase transition-colors duration-150 hover:text-ink-2 max-[900px]:flex-wrap"
      >
        <span className="w-[11px] font-meta text-muted">{open ? '–' : '+'}</span>
        {`${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'} MusicBrainz cannot place yet`}
        <span className="font-display text-[12px] tracking-normal text-rule normal-case italic group-hover:text-muted">
          {open ? 'hide' : 'see what is missing'}
        </span>
      </button>

      {open && (
        <div className="mt-[10px]">
          {groups.map(([code, group]) => (
            <div key={code} className="py-[7px]">
              <div className="flex items-baseline gap-[9px]">
                <span className="font-display text-[13px] text-ink-2">{REASONS[code]}</span>
                <span className="font-meta text-[10px] tracking-[0.14em] text-muted uppercase tabular-nums">
                  {group.length}
                </span>
              </div>
              <ul className="mt-[3px] list-none pl-0">
                {group.map((track) => {
                  const destination = gapRoute(code, {
                    spotifyAlbumId: track.spotifyAlbumId,
                  });
                  return (
                    <li
                      key={track.spotifyTrackId}
                      className="flex min-w-0 items-baseline gap-2 py-[2px] font-display text-[12px] text-muted italic"
                    >
                      <span className="min-w-0 truncate">
                        {track.providerTitle ?? track.spotifyTrackId}
                        {track.musicBrainz?.recordingTitle && (
                          <span className="not-italic">
                            {' '}
                            · MusicBrainz: {track.musicBrainz.recordingTitle}
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        className="shrink-0 font-meta text-[9px] tracking-[0.12em] text-muted uppercase hover:text-ink disabled:opacity-50"
                        disabled={
                          queued.has(track.spotifyTrackId) || sending.has(track.spotifyTrackId)
                        }
                        onClick={() => send(track.spotifyTrackId)}
                      >
                        {queued.has(track.spotifyTrackId)
                          ? 'Queued'
                          : sending.has(track.spotifyTrackId)
                            ? 'Sending…'
                            : 'Send for matching'}
                      </button>
                      {isAdmin && destination && (
                        <Link
                          href={adminGapHref(destination)}
                          className="shrink-0 font-meta text-[9px] tracking-[0.12em] text-muted uppercase not-italic hover:text-ink"
                        >
                          open in admin
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
