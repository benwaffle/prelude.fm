'use client';

import type { ContributionView } from '../actions/inbox-view';
import { InboxSection } from './InboxSection';
import { LoadMoreRows } from './LoadMoreRows';

const WHY = {
  number: 'a single number of an opera, Mass or similar',
  'parts-on-album': 'other tracks on this album are linked to its parts',
  'several-tracks': 'several tracks of different lengths on this album share the link',
} as const;

export function WholeWorkLinksSection({
  rows,
  total,
  onLoadMore,
}: {
  rows: ContributionView['wholeWork'];
  total: number;
  onLoadMore: () => void;
}) {
  return (
    <InboxSection
      inboxClass="whole-work"
      title="Movements linked to a whole work"
      channel="HAND"
      total={total}
      shown={rows.length}
      description="These tracks are linked to a work that has parts, but look like one part of it. Change the recording's work to the right movement on MusicBrainz, then refresh the work in Tools. Tracks that really are the whole piece are left out."
    >
      {rows.map((link) => (
        <div
          key={`${link.trackId}:${link.workMbid}`}
          data-inbox-album={link.albumId}
          className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-[var(--rule)] px-4 py-3"
        >
          <div className="min-w-0 flex-1">
            <span className="block truncate">{link.trackTitle}</span>
            <span className="album-meta">
              {link.albumTitle} · linked to {link.workTitle ?? 'an untitled work'} ·{' '}
              {WHY[link.reason]}
            </span>
          </div>
          <a className="act" href={link.recordingEdit} target="_blank" rel="noreferrer">
            Edit recording
          </a>
          <a
            className="act"
            href={`https://musicbrainz.org/work/${link.workMbid}`}
            target="_blank"
            rel="noreferrer"
          >
            Work
          </a>
        </div>
      ))}
      <LoadMoreRows shown={rows.length} total={total} busy={false} onMore={onLoadMore} />
    </InboxSection>
  );
}
