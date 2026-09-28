import type { PreparedSeed } from '@/lib/release-seeding-run';
import {
  RELEASE_ADD_URL,
  seedFields,
  type RecordingDecision,
  type SeedPlan,
} from '@/lib/release-seeding';

const minutes = (ms: number) => {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * The seeded release editor, opened in a new tab by a real form POST from
 * this browser: MusicBrainz only accepts a seed with the person's own
 * session, and the edit is theirs to review and enter.
 */
export function SeedOnMusicBrainzForm({
  albumId,
  plan,
  onSeeded,
}: {
  albumId: string;
  plan: SeedPlan;
  onSeeded: (albumId: string) => void;
}) {
  return (
    <form
      method="post"
      action={RELEASE_ADD_URL}
      target="_blank"
      className="inline"
      onSubmit={() => onSeeded(albumId)}
    >
      {seedFields(plan).map(([name, value], index) => (
        <input key={`${name}:${index}`} type="hidden" name={name} value={value} />
      ))}
      <button type="submit" className="act" title="Opens the MusicBrainz release editor, seeded">
        Seed on MusicBrainz
      </button>
    </form>
  );
}

function RecordingCell({ decision }: { decision: RecordingDecision }) {
  switch (decision.state) {
    case 'matched':
      return (
        <>
          <a
            className="mono"
            href={`https://musicbrainz.org/recording/${decision.recordingMbid}`}
            target="_blank"
            rel="noreferrer"
          >
            {decision.recordingMbid.slice(0, 8)}
          </a>{' '}
          <span className="album-meta">{decision.why}</span>
        </>
      );
    case 'ambiguous':
      return (
        <span className="absent">
          Left empty — {decision.reason}
          {decision.candidates.map((mbid) => (
            <span key={mbid}>
              {' '}
              <a
                className="mono"
                href={`https://musicbrainz.org/recording/${mbid}`}
                target="_blank"
                rel="noreferrer"
              >
                {mbid.slice(0, 8)}
              </a>
            </span>
          ))}
        </span>
      );
    case 'none':
      return <span className="album-meta">New recording — {decision.reason}</span>;
  }
}

/** What the seed will pre-fill, track by track, before anyone opens it. */
export function SeedPreview({ seed }: { seed: PreparedSeed }) {
  const { plan } = seed;
  const ambiguous = plan.tracks.filter((track) => track.recording.state === 'ambiguous');
  return (
    <div className="flex flex-col gap-2 text-[12px]">
      <p>
        <strong>
          {plan.counts.prefilled} of {plan.counts.tracks} recordings pre-filled
        </strong>
        {plan.counts.ambiguous > 0 && `, ${plan.counts.ambiguous} left empty as ambiguous`}
        {`, ${plan.counts.none} will be new recordings.`}
      </p>
      <p>
        Release group:{' '}
        {plan.releaseGroupMbid ? (
          <a
            href={`https://musicbrainz.org/release-group/${plan.releaseGroupMbid}`}
            target="_blank"
            rel="noreferrer"
          >
            existing group {plan.releaseGroupMbid.slice(0, 8)}
          </a>
        ) : (
          'new (none seeded)'
        )}
        {plan.releaseGroupNote && <span className="absent"> — {plan.releaseGroupNote}</span>}
        {plan.editions.length > 0 && (
          <span className="album-meta">
            {' '}
            · positions from{' '}
            {plan.editions.map((edition, index) => (
              <span key={edition.releaseMbid}>
                {index > 0 && ', '}
                <a
                  href={`https://musicbrainz.org/release/${edition.releaseMbid}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {edition.releaseTitle}
                </a>
              </span>
            ))}
          </span>
        )}
      </p>
      <p className="album-meta">
        Release artist:{' '}
        {plan.releaseCredit.length === 0
          ? 'none from Spotify'
          : plan.releaseCredit
              .map((part) => `${part.name}${part.mbid ? '' : ' (no MBID)'}`)
              .join(', ')}
        . Track artist: the composer where one is identified, else Spotify’s credit. New recordings
        copy the track artist — set their performers in the editor.
      </p>
      {plan.notes.map((note) => (
        <p key={note} className="absent">
          {note}
        </p>
      ))}
      {ambiguous.length > 0 && (
        <p className="absent">
          Ambiguous, pick by hand if right: tracks{' '}
          {ambiguous.map((track) => `${track.disc}.${track.position}`).join(', ')}.
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-[var(--ink-2)]">Track by track</summary>
        <table className="w-full text-left">
          <thead className="text-[var(--ink-2)]">
            <tr>
              <th className="pr-3 font-normal">#</th>
              <th className="pr-3 font-normal">Title</th>
              <th className="pr-3 font-normal">Length</th>
              <th className="pr-3 font-normal">Track artist</th>
              <th className="font-normal">Recording</th>
            </tr>
          </thead>
          <tbody>
            {plan.tracks.map((track) => (
              <tr key={`${track.disc}-${track.position}`} className="align-top">
                <td className="mono pr-3">
                  {track.disc}.{track.position}
                </td>
                <td className="pr-3">{track.title}</td>
                <td className="mono pr-3">{minutes(track.lengthMs)}</td>
                <td className="pr-3">
                  {track.credit.map((part) => part.name).join(', ')}
                  {track.creditShape === 'as-spotify' && (
                    <span className="album-meta"> (as Spotify — composer not identified)</span>
                  )}
                </td>
                <td>
                  <RecordingCell decision={track.recording} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <details>
        <summary className="cursor-pointer text-[var(--ink-2)]">Edit note</summary>
        <pre className="whitespace-pre-wrap">{plan.editNote}</pre>
      </details>
      <p className="album-meta">
        Prepared {new Date(seed.preparedAt).toLocaleString()} · {seed.requests} MusicBrainz
        request(s)
        {seed.seededAt && ` · opened on MusicBrainz ${new Date(seed.seededAt).toLocaleString()}`}
      </p>
    </div>
  );
}
