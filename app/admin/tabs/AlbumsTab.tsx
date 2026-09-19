'use client';

import { useEffect, useState } from 'react';
import { getAlbumTracks, getAlbums, getIsrcSeeds, recheckAlbum } from '../actions/coverage';
import {
  STATE_LABEL,
  type AlbumRow,
  type AlbumState,
  type AlbumTrackRow,
} from '../lib/album-state';
import { Spinner } from '../components/Spinner';

const HARMONY = 'https://harmony.pulsewidth.org.uk';
const MAGICISRC = 'https://magicisrc.kepstin.ca';

/**
 * A MagicISRC link for a release, with the ISRCs already placed where we can
 * place them safely.
 *
 * MagicISRC seeds by medium and track (`isrcM-T`). We do not store which
 * MusicBrainz medium a track sits on, so positions are only filled in for an
 * album on a single disc, where medium 1 is the only possibility. A multi-disc
 * album gets the release alone and the ISRCs pasted by hand, because a seed
 * off by one medium attaches every ISRC to the wrong recording.
 */
function magicIsrcUrl(releaseMbid: string, seed?: { discs: number; isrcs: string[] }) {
  const params = new URLSearchParams({ musicbrainzid: releaseMbid });
  if (seed && seed.discs === 1) {
    seed.isrcs.forEach((isrc, index) => params.set(`isrc1-${index + 1}`, isrc));
    params.set(
      'edit-note',
      'ISRCs sourced from Spotify, matched to this release by barcode (UPC).',
    );
  }
  return `${MAGICISRC}/?${params.toString()}`;
}

/**
 * The one thing to do about this album, and the tool that does it.
 *
 * Both link into Harmony, which already talks to Spotify and MusicBrainz and
 * carries the client attribution MusicBrainz editors look for. Sending someone
 * to a tool the community already trusts beats anything we would build here.
 */
function nextStep(
  album: AlbumRow,
  seed?: { discs: number; isrcs: string[] },
): { label: string; href: string; hint: string } | null {
  const spotifyUrl = `https://open.spotify.com/album/${album.id}`;
  const addRelease = {
    label: 'Add release',
    href: `${HARMONY}/release?url=${encodeURIComponent(spotifyUrl)}`,
    hint: 'Opens Harmony with this Spotify album loaded, ready to import into MusicBrainz.',
  };

  switch (album.state) {
    case 'anchored':
    case 'unchecked':
      return null;

    case 'partial':
    case 'needs_isrcs':
      // With the release known, the missing piece is ISRCs. Without it, some of
      // these recordings are in MusicBrainz already — reached through some other
      // release — but this pressing is not, so it is the release that is missing.
      return album.mbReleaseId
        ? {
            label: 'Submit ISRCs',
            href: magicIsrcUrl(album.mbReleaseId, seed),
            hint:
              seed && seed.discs === 1
                ? 'Opens MagicISRC with the ISRCs filled in. It shows a diff before anything is written.'
                : 'Opens MagicISRC for this release. Multi-disc, so the ISRCs need placing by hand.',
          }
        : addRelease;

    case 'absent':
      return addRelease;

    case 'ambiguous':
      return {
        label: 'Pick release',
        href: `https://musicbrainz.org/search?type=release&query=${encodeURIComponent(
          album.upc ?? album.title,
        )}`,
        hint: 'Several releases share this barcode. The release exists — choose the right one.',
      };
  }
}

export function AlbumsTab({
  state,
  onStateChange,
}: {
  state?: AlbumState;
  onStateChange: (state?: AlbumState) => void;
}) {
  const [search, setSearch] = useState('');
  const [albums, setAlbums] = useState<AlbumRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [tracks, setTracks] = useState<Record<string, AlbumTrackRow[]>>({});
  const [seeds, setSeeds] = useState<Record<string, { discs: number; isrcs: string[] }>>({});
  const [rechecking, setRechecking] = useState<string | null>(null);
  const [recheckResult, setRecheckResult] = useState<Record<string, string>>({});

  // The filter lives with the page, because Coverage sets it when you click a
  // row there. Keeping a second copy here only created two things to keep in
  // step. Previous results stay on screen while the next set loads, so
  // changing filter does not blank the page.
  useEffect(() => {
    let cancelled = false;
    void getAlbums(state, search).then(async (rows) => {
      if (cancelled) return;
      setAlbums(rows);
      // Only the albums whose next step is an ISRC submission need their
      // ISRCs, and only those on screen.
      const needSeeds = rows
        .filter(
          (row) => row.mbReleaseId && (row.state === 'partial' || row.state === 'needs_isrcs'),
        )
        .map((row) => row.id);
      if (needSeeds.length === 0) return;
      const fetched = await getIsrcSeeds(needSeeds);
      if (!cancelled) setSeeds(fetched);
    });
    return () => {
      cancelled = true;
    };
  }, [state, search]);

  async function recheck(albumId: string) {
    setRechecking(albumId);
    try {
      const result = await recheckAlbum(albumId);
      setRecheckResult((current) => ({
        ...current,
        [albumId]:
          result.resolved > 0
            ? `matched ${result.resolved} more — ${result.anchored}/${result.tracks} anchored`
            : `no change — ${result.anchored}/${result.tracks} anchored`,
      }));
      setAlbums(await getAlbums(state, search));
    } finally {
      setRechecking(null);
    }
  }

  async function toggle(albumId: string) {
    if (open === albumId) {
      setOpen(null);
      return;
    }
    setOpen(albumId);
    if (!tracks[albumId]) {
      const rows = await getAlbumTracks(albumId);
      setTracks((current) => ({ ...current, [albumId]: rows }));
    }
  }

  const states: AlbumState[] = [
    'absent',
    'needs_isrcs',
    'partial',
    'ambiguous',
    'anchored',
    'unchecked',
  ];

  return (
    <div className="flex flex-col gap-5 pb-16">
      <div className="panel">
        <div className="toolbar">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find an album"
            className="min-w-[220px] flex-1"
          />
          <button className="act" onClick={() => onStateChange(undefined)} disabled={!state}>
            All
          </button>
          {states.map((item) => (
            <button
              key={item}
              className="act"
              onClick={() => onStateChange(item)}
              disabled={state === item}
            >
              {STATE_LABEL[item]}
            </button>
          ))}
        </div>
      </div>

      {!albums ? (
        <div className="flex items-center gap-2 py-10 text-[var(--faint)]">
          <Spinner className="h-3 w-3" />
          <span className="text-xs">Loading…</span>
        </div>
      ) : albums.length === 0 ? (
        <div className="slip px-4 py-5 text-[var(--ink-2)]">No albums here.</div>
      ) : (
        <div className="slip">
          {albums.map((album) => {
            const step = nextStep(album, seeds[album.id]);
            const isOpen = open === album.id;
            return (
              <div key={album.id} className="rule-b last:border-b-0">
                <div className="album-row">
                  <button className="album-open" onClick={() => toggle(album.id)}>
                    <span className="album-title">{album.title}</span>
                    <span className="album-meta">
                      <span
                        className={`mono ${
                          album.state === 'anchored'
                            ? 'text-[var(--viridian)]'
                            : 'text-[var(--gall)]'
                        }`}
                      >
                        {album.anchored}/{album.tracks}
                      </span>
                      <span className="text-[var(--faint)]">anchored</span>
                      <span className="tag">{STATE_LABEL[album.state]}</span>
                    </span>
                  </button>
                  {recheckResult[album.id] && (
                    <span className="shrink-0 text-[11px] text-[var(--viridian)]">
                      {recheckResult[album.id]}
                    </span>
                  )}
                  {album.state !== 'anchored' && (
                    <button
                      className="act shrink-0"
                      disabled={rechecking === album.id}
                      onClick={() => recheck(album.id)}
                      title="Ask MusicBrainz about this album's ISRCs again. Use it after submitting."
                    >
                      {rechecking === album.id ? 'Checking…' : 'Re-check'}
                    </button>
                  )}
                  {step && (
                    <a
                      className="act shrink-0"
                      data-variant="primary"
                      href={step.href}
                      target="_blank"
                      rel="noreferrer"
                      title={step.hint}
                    >
                      {step.label}
                    </a>
                  )}
                </div>

                {isOpen && (
                  <div className="px-4 pb-3">
                    {!tracks[album.id] ? (
                      <Spinner className="h-3 w-3" />
                    ) : (
                      <table>
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>Track</th>
                            <th>ISRC</th>
                            <th>MusicBrainz</th>
                            <th>Work</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tracks[album.id].map((track) => (
                            <tr key={track.id}>
                              <td className="mono text-[var(--faint)]">
                                {track.discNumber}.{track.trackNumber}
                              </td>
                              <td>{track.title}</td>
                              <td className="mono text-[11px] text-[var(--ink-2)]">
                                {track.isrc ?? <span className="absent">none</span>}
                              </td>
                              <td>
                                {track.mbRecordingId ? (
                                  <a
                                    className="mono text-[11px] text-[var(--viridian)]"
                                    href={`https://musicbrainz.org/recording/${track.mbRecordingId}`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    anchored
                                  </a>
                                ) : (
                                  <span className="absent">not matched</span>
                                )}
                              </td>
                              <td className="text-[var(--ink-2)]">
                                {track.parts.length === 0 ? (
                                  <span className="absent">unmatched</span>
                                ) : (
                                  track.parts.map((part) => (
                                    <span key={part.partId} className="block">
                                      {part.workTitle}
                                      {(part.label || part.title) && (
                                        <span className="text-[var(--faint)]">
                                          {' · '}
                                          {[part.label, part.title].filter(Boolean).join('. ')}
                                        </span>
                                      )}
                                    </span>
                                  ))
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
