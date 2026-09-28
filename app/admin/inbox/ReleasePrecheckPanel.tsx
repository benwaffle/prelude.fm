import type { CachedPrecheck } from '@/lib/release-precheck-run';
import {
  artistUrl,
  recordingUrl,
  releaseUrl,
  type ArtistMatch,
  type ArtistRole,
  type ArtistSuggestion,
  type ExistingVerdict,
  type LookupState,
} from '@/lib/release-precheck';

const VERDICT_LABEL: Record<ExistingVerdict, string> = {
  'possible-duplicate': 'May already exist',
  'new-edition': 'New edition',
  'maybe-edition': "Couldn't tell: same title",
  'recordings-exist': 'Recordings exist',
  'looks-new': 'Looks new',
  'couldnt-tell': "Couldn't tell",
};

const ROLE_LABEL: Record<ArtistRole, string> = {
  composer: 'composer',
  performer: 'performer',
  'composer-and-performer': 'composer and performer',
  'couldnt-tell': "couldn't tell",
};

function ago(date: Date): string {
  const minutes = Math.round((Date.now() - new Date(date).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** One line for the row: the verdict and how much the checklist holds. */
export function PrecheckSummary({ precheck }: { precheck: CachedPrecheck | null }) {
  if (!precheck) {
    return <span className="album-meta absent">Not pre-checked yet — run it before Harmony</span>;
  }
  const { result } = precheck;
  return (
    <span className="album-meta">
      <span className="tag">{VERDICT_LABEL[result.existing.verdict]}</span>{' '}
      {result.checklist.length} thing(s) to check · pre-checked {ago(precheck.checkedAt)}
    </span>
  );
}

function lookupNote(label: string, state: LookupState<unknown>) {
  if (state.state === 'failed') return `${label}: couldn't tell — lookup failed (${state.error})`;
  if (state.state === 'skipped') return `${label}: not run — ${state.reason}`;
  return null;
}

function MatchCell({ match }: { match: ArtistMatch }) {
  const link = (artist: { mbid: string; name: string; disambiguation: string | null }) => (
    <a key={artist.mbid} href={artistUrl(artist.mbid)} target="_blank" rel="noreferrer">
      {artist.name}
      {artist.disambiguation ? ` (${artist.disambiguation})` : ''}
    </a>
  );
  switch (match.state) {
    case 'linked':
      return <>Linked to Spotify: {link(match.artist)}</>;
    case 'several-linked':
      return (
        <>
          Several artists linked to this Spotify page:{' '}
          {match.candidates.map((artist, index) => (
            <span key={artist.mbid}>
              {index > 0 && ', '}
              {link(artist)}
            </span>
          ))}
        </>
      );
    case 'name-match':
      return <>Not linked; one artist has this exact name: {link(match.artist)}</>;
    case 'ambiguous':
      return (
        <>
          Not linked; {match.candidates.length} artists share this name:{' '}
          {match.candidates.slice(0, 4).map((artist, index) => (
            <span key={artist.mbid}>
              {index > 0 && ', '}
              {link(artist)}
            </span>
          ))}
        </>
      );
    case 'not-found':
      return <span className="absent">No MusicBrainz artist found</span>;
    case 'not-looked-up':
      return <span className="absent">Not looked up: {match.reason}</span>;
    case 'failed':
      return <span className="absent">Couldn&apos;t tell — lookup failed ({match.error})</span>;
  }
}

function ArtistRows({ artists }: { artists: ArtistSuggestion[] }) {
  return (
    <table className="w-full text-left text-[12px]">
      <thead className="text-[var(--ink-2)]">
        <tr>
          <th className="pr-3 font-normal">Spotify artist</th>
          <th className="pr-3 font-normal">Tracks</th>
          <th className="pr-3 font-normal">MusicBrainz</th>
          <th className="font-normal">Role</th>
        </tr>
      </thead>
      <tbody>
        {artists.map((artist) => (
          <tr key={artist.spotifyId ?? artist.name} className="align-top">
            <td className="pr-3">
              {artist.name}
              {artist.onAlbum && <span className="album-meta"> · album artist</span>}
            </td>
            <td className="mono pr-3">{artist.tracks}</td>
            <td className="pr-3">
              <MatchCell match={artist.match} />
            </td>
            <td title={artist.roleWhy}>
              <span className={artist.role === 'couldnt-tell' ? 'absent' : undefined}>
                {ROLE_LABEL[artist.role]}
              </span>
              <span className="album-meta block">{artist.roleWhy}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Everything the pre-check found, in the order it matters before Harmony. */
export function ReleasePrecheckPanel({ precheck }: { precheck: CachedPrecheck }) {
  const { result } = precheck;
  const notes = [
    lookupNote('Release search', result.releases),
    lookupNote('Release group search', result.groups),
    lookupNote('ISRC lookup', result.isrcs),
  ].filter((note): note is string => note !== null);
  const releases = result.releases.state === 'done' ? result.releases.value : [];
  const isrcHits = result.isrcs.state === 'done' ? result.isrcs.value.hits : [];

  return (
    <div className="flex flex-col gap-4 text-[12px]">
      <section>
        <p className="eyebrow mb-1">Is it really missing?</p>
        <p>
          <span className="tag">{VERDICT_LABEL[result.existing.verdict]}</span>{' '}
          {result.existing.headline}
        </p>
        {result.existing.links.length > 0 && (
          <ul className="mt-1 list-disc pl-5">
            {result.existing.links.map((link) => (
              <li key={link.href}>
                <a href={link.href} target="_blank" rel="noreferrer">
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        )}
        {releases.length > 0 && (
          <details className="mt-1">
            <summary className="cursor-pointer text-[var(--ink-2)]">
              {releases.length} release(s) with a similar title
              {result.searchedArtist ? ` by ${result.searchedArtist}` : ''}
            </summary>
            <ul className="list-disc pl-5">
              {releases.map((release) => (
                <li key={release.mbid}>
                  <a href={releaseUrl(release.mbid)} target="_blank" rel="noreferrer">
                    {release.title}
                  </a>{' '}
                  <span className="album-meta">
                    {[
                      release.artist,
                      release.date,
                      release.country,
                      release.trackCount !== null ? `${release.trackCount} tracks` : null,
                      release.barcode ? `barcode ${release.barcode}` : 'no barcode',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {isrcHits.length > 0 && (
          <details className="mt-1">
            <summary className="cursor-pointer text-[var(--ink-2)]">
              {new Set(isrcHits.map((hit) => hit.isrc)).size} track(s) whose ISRC already has a
              recording
            </summary>
            <ul className="list-disc pl-5">
              {isrcHits.map((hit) => (
                <li key={`${hit.isrc}:${hit.recordingMbid}`}>
                  <span className="mono">{hit.isrc}</span>{' '}
                  <a href={recordingUrl(hit.recordingMbid)} target="_blank" rel="noreferrer">
                    {hit.recordingTitle}
                  </a>
                  {hit.groups.length > 0 && (
                    <span className="album-meta">
                      {' '}
                      · on {hit.groups.map((group) => group.title).join(', ')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
        {notes.map((note) => (
          <p key={note} className="absent">
            {note}
          </p>
        ))}
        {!result.searchedArtist && (
          <p className="album-meta">
            Title searches were not narrowed by artist (no usable album artist).
          </p>
        )}
      </section>

      <section>
        <p className="eyebrow mb-1">Artists</p>
        <ArtistRows artists={result.artists} />
      </section>

      <section>
        <p className="eyebrow mb-1">Check in Harmony and the release editor</p>
        {result.checklist.length === 0 ? (
          <p>Nothing specific found. Still read the seeded form before entering the edit.</p>
        ) : (
          <ul className="list-disc pl-5">
            {result.checklist.map((item) => (
              <li key={item.key}>
                {item.text}
                {item.links?.map((link) => (
                  <span key={link.href}>
                    {' '}
                    <a href={link.href} target="_blank" rel="noreferrer">
                      {link.label}
                    </a>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="album-meta">
        Seed read from {result.seed.source === 'spotify' ? 'Spotify' : 'our stored copy'} ·{' '}
        {result.seed.tracks.length} tracks · {precheck.requests} MusicBrainz request(s) · checked{' '}
        {ago(precheck.checkedAt)}
      </p>
    </div>
  );
}
