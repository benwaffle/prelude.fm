'use client';

import { useState } from 'react';
import type { MusicBrainzGapCode, UnresolvedLibraryTrack } from '@/lib/musicbrainz-library';

/**
 * Held tracks the MusicBrainz reader could not put on a card, grouped by
 * what is missing.
 *
 * Deliberately quiet, like the strip it sits beside — but it does say what
 * is wrong. "We couldn't identify this" is the answer that stops the work;
 * "MusicBrainz has no release for this album" is the one that starts it.
 */
const REASONS: Record<MusicBrainzGapCode, string> = {
  'provider-track-not-fetched': 'Spotify track not read yet',
  'provider-album-not-fetched': 'Spotify album not read yet',
  'classification-unreviewed': 'Nobody has decided whether this is classical',
  'classification-uncertain': 'MusicBrainz does not settle whether this is classical',
  'classification-not-classical': 'Ruled not classical',
  'release-not-checked': 'Nobody has looked for this album in MusicBrainz',
  'release-missing': 'MusicBrainz has no release for this album',
  'release-ambiguous': 'Several MusicBrainz releases carry this barcode',
  'release-tracklist-misaligned': 'The MusicBrainz tracklist does not line up',
  'release-cache-missing': 'The matched release has not been fetched',
  'release-title-missing': 'The MusicBrainz release has no title',
  'release-date-missing': 'The MusicBrainz release has no date',
  'release-spotify-streaming-url-missing':
    'The MusicBrainz release has no Spotify free-streaming URL',
  'release-track-position-mismatch': 'The release position contradicts the anchor',
  'recording-unanchored': 'No MusicBrainz recording matched this track',
  'recording-anchor-conflict': 'One ISRC names more than one MusicBrainz recording',
  'recording-cache-missing': 'The matched recording has not been fetched',
  'recording-stub': 'Only the recording’s name is known',
  'recording-title-missing': 'The MusicBrainz recording has no title',
  'recording-work-missing': 'MusicBrainz does not relate this recording to a work',
  'work-cache-missing': 'The work has not been fetched',
  'work-stub': 'Only the work’s name is known',
  'work-title-missing': 'The MusicBrainz work has no title',
  'work-type-missing': 'The MusicBrainz work has no type',
  'work-catalogue-missing': 'No catalogue reference on the work or above it',
  'work-composer-missing': 'MusicBrainz does not say who wrote this',
  'composer-cache-missing': 'The composer has not been fetched',
  'composer-name-missing': 'The MusicBrainz composer has no name',
  'work-hierarchy-parent-missing': 'The work’s parent has not been fetched',
  'work-hierarchy-cycle': 'The cached work hierarchy loops',
  'work-level-ambiguous': 'Unclear whether to show this work or the one above it',
  'recording-credits-missing': 'MusicBrainz does not say who performed',
  'recording-credit-artist-missing': 'A credited artist has not been fetched',
};

export function GapStrip({ tracks }: { tracks: UnresolvedLibraryTrack[] }) {
  const [open, setOpen] = useState(false);
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
                {group.map((track) => (
                  <li
                    key={track.spotifyTrackId}
                    className="truncate py-[2px] font-display text-[12px] text-muted italic"
                  >
                    {track.providerTitle ?? track.spotifyTrackId}
                    {track.musicBrainz?.recordingTitle && (
                      <span className="not-italic">
                        {' '}
                        · MusicBrainz: {track.musicBrainz.recordingTitle}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
