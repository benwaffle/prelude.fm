'use client';

import type { ContributionView } from '../actions/inbox-view';
import { recordContestedIsrcReport } from '../actions/submissions';
import { ErrorReportSection } from './ErrorReportSection';

export function ContestedIsrcsSection({
  rows,
  total,
  onReload,
  onLoadMore,
}: {
  rows: ContributionView['contested'];
  total: number;
  onReload: () => Promise<void>;
  onLoadMore: () => void;
}) {
  return (
    <ErrorReportSection
      inboxClass="contested"
      title="One ISRC, several recordings"
      description="An ISRC identifies one recording. Every conflicting MusicBrainz recording remains visible until the cache shows the correction."
      rows={rows}
      total={total}
      onReload={onReload}
      onLoadMore={onLoadMore}
      keyOf={(row) => row.isrc}
      record={recordContestedIsrcReport}
      evidence={(row) => (
        <>
          <span className="mono block">{row.isrc}</span>
          <span className="block text-[11px] text-[var(--ink-2)]">{row.titles}</span>
          {row.judgement && <ContestedVerdict judgement={row.judgement} />}
          <span className="album-meta">
            {row.recordingMbids.map((mbid) => (
              <span key={mbid} className="mono">
                {mbid}
              </span>
            ))}
          </span>
        </>
      )}
      links={(row) => (
        <a className="act" href={row.isrcUrl} target="_blank" rel="noreferrer">
          MusicBrainz
        </a>
      )}
      tools={(row) =>
        row.recordingMbids.map((mbid) => (
          <a
            key={mbid}
            className="act"
            href={`https://musicbrainz.org/recording/${mbid}`}
            target="_blank"
            rel="noreferrer"
          >
            Recording
          </a>
        ))
      }
    />
  );
}

type Judgement = NonNullable<ContributionView['contested'][number]['judgement']>;

function RecordingName({ judgement, mbid }: { judgement: Judgement; mbid: string }) {
  const claimant = judgement.claimants.find((entry) => entry.recordingMbid === mbid);
  return (
    <a href={`https://musicbrainz.org/recording/${mbid}`} target="_blank" rel="noreferrer">
      {claimant?.title ?? <span className="mono">{mbid}</span>}
      {claimant?.lengthMs != null && ` (${formatLength(claimant.lengthMs)})`}
    </a>
  );
}

function formatLength(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function RecordingList({ judgement, mbids }: { judgement: Judgement; mbids: string[] }) {
  return (
    <>
      {mbids.map((mbid, index) => (
        <span key={mbid}>
          {index > 0 && '; '}
          <RecordingName judgement={judgement} mbid={mbid} />
        </span>
      ))}
    </>
  );
}

function ContestedVerdict({ judgement }: { judgement: Judgement }) {
  const { verdict } = judgement;
  const lines: React.ReactNode[] = [];
  if (verdict.kind === 'owner') {
    lines.push(
      verdict.basis === 'release-position' ? (
        <>
          Belongs to <RecordingName judgement={judgement} mbid={verdict.ownerMbid} />: a library
          track with this ISRC sits at that recording&apos;s place on its own release, and the
          lengths match.
        </>
      ) : (
        <>
          Probably <RecordingName judgement={judgement} mbid={verdict.ownerMbid} />: the only one
          that runs the length of the library track with this ISRC. That track could not be placed
          on its release, so this is weaker.
        </>
      ),
    );
    if (verdict.remove.length > 0) {
      lines.push(
        <>
          Remove the ISRC from <RecordingList judgement={judgement} mbids={verdict.remove} />.
        </>,
      );
    }
    if (verdict.duplicates.length > 0) {
      lines.push(
        <>
          Same length and no ISRC of its own, so likely the same performance entered twice; merge:{' '}
          <RecordingList judgement={judgement} mbids={verdict.duplicates} />.
        </>,
      );
    }
    if (verdict.unclear.length > 0) {
      lines.push(
        <>
          No evidence either way for <RecordingList judgement={judgement} mbids={verdict.unclear} />
          .
        </>,
      );
    }
  } else if (verdict.kind === 'stray') {
    lines.push(
      <>
        No library track carries this ISRC, and each of these recordings already has its own ISRC on
        a Spotify track. It looks wrongly added to all of them.
      </>,
    );
  } else {
    lines.push(<>Undecided: {verdict.reason}.</>);
  }
  return (
    <span className="block text-[11px]">
      {lines.map((line, index) => (
        <span key={index} className="block">
          {line}
        </span>
      ))}
    </span>
  );
}
