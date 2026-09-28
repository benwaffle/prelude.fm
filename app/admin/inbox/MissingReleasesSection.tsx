'use client';

import { useState } from 'react';
import { adminFailureMessage } from '../components/AdminFailure';
import { useAdminAction } from '../components/useAdminAction';
import {
  attachPickedReleaseToAlbum,
  lookupBarcodeReleaseHits,
  measureReleaseCorrections,
  prepareMusicBrainzSeed,
  recordMusicBrainzSeeded,
  recordReleaseSubmission,
  recheckReleaseSubmission,
  runReleasePrecheck,
  type ContributionView,
} from '../actions/contribute';
import type { CachedPrecheck } from '@/lib/release-precheck-run';
import type { PreparedSeed } from '@/lib/release-seeding-run';
import { SeedOnMusicBrainzForm, SeedPreview } from './MusicBrainzSeed';
import { MbPicker } from '../components/MbPicker';
import type { InboxClass } from '../lib/admin-url';
import {
  AMBIGUOUS_BARCODE_REASON,
  barcodeReleaseSearchUrl,
  type MbPickHit,
} from '@/lib/musicbrainz-pick';
import { ChannelBadge } from './ChannelBadge';
import { ConfirmDisclosure } from './ConfirmDisclosure';
import { InboxRow } from './InboxRow';
import { PreviousSubmission } from './PreviousSubmission';
import { PrecheckSummary, ReleasePrecheckPanel } from './ReleasePrecheckPanel';
import { RowActionStatus } from './RowActionStatus';
import { InboxSection } from './InboxSection';
import { LoadMoreRows } from './LoadMoreRows';

export function MissingReleasesSection({
  rows,
  total,
  activeClass,
  onReload,
  onLoadMore,
}: {
  rows: ContributionView['missing'];
  total: number;
  activeClass?: InboxClass;
  onReload: () => Promise<void>;
  onLoadMore: () => void;
}) {
  const { pending, busy, runRow, row } = useAdminAction();
  const [forms, setForms] = useState<Record<string, { releaseMbid: string; editId: string }>>({});
  const [liveHits, setLiveHits] = useState<Record<string, MbPickHit[]>>({});
  const [lookup, setLookup] = useState<Record<string, string | 'loading'>>({});
  const [prechecks, setPrechecks] = useState<Record<string, CachedPrecheck>>({});
  const [seeds, setSeeds] = useState<Record<string, PreparedSeed>>({});

  /*
   * Once the release is attached, what was corrected is measured straight
   * away. A failure stays on the row; the Details tab lists every added
   * album that still has no measurement, with a button to retry.
   */
  async function confirm(albumId: string) {
    const form = forms[albumId] ?? { releaseMbid: '', editId: '' };
    await runRow(albumId, 'Confirming and attaching the release…', async () => {
      const { landed } = await recordReleaseSubmission(albumId, form);
      if (landed) await measureReleaseCorrections(albumId);
      await onReload();
    });
  }

  async function recheck(albumId: string) {
    await runRow(albumId, 'Rechecking MusicBrainz…', async () => {
      const { landed } = await recheckReleaseSubmission(albumId);
      if (landed) await measureReleaseCorrections(albumId);
      await onReload();
    });
  }

  async function precheck(albumId: string) {
    await runRow(albumId, 'Pre-checking against MusicBrainz…', async () => {
      const result = await runReleasePrecheck(albumId);
      setPrechecks((current) => ({ ...current, [albumId]: result }));
    });
  }

  async function prepareSeed(albumId: string) {
    await runRow(albumId, 'Preparing the MusicBrainz seed…', async () => {
      const result = await prepareMusicBrainzSeed(albumId);
      setSeeds((current) => ({ ...current, [albumId]: result }));
    });
  }

  /*
   * The form opens MusicBrainz itself; this only notes that it was opened,
   * so the correction record compares against our seed. Not awaited: the
   * submit must stay a direct user action or the new tab is blocked.
   */
  function seeded(albumId: string) {
    void recordMusicBrainzSeeded(albumId).then(() =>
      setSeeds((current) => {
        const seed = current[albumId] ?? rows.find((row) => row.albumId === albumId)?.seed;
        return seed ? { ...current, [albumId]: { ...seed, seededAt: new Date() } } : current;
      }),
    );
  }

  async function lookUp(albumId: string, upc: string) {
    setLookup((current) => ({ ...current, [albumId]: 'loading' }));
    try {
      const result = await lookupBarcodeReleaseHits(upc);
      setLiveHits((current) => ({ ...current, [albumId]: result.hits }));
      setLookup((current) => ({
        ...current,
        [albumId]:
          result.error ??
          (result.hits.length === 0 ? 'MusicBrainz returned no releases for this barcode' : ''),
      }));
    } catch (error) {
      setLookup((current) => ({
        ...current,
        [albumId]: adminFailureMessage(error),
      }));
    }
  }

  async function pick(albumId: string, releaseMbid: string) {
    setForms((current) => ({
      ...current,
      [albumId]: {
        ...(current[albumId] ?? { releaseMbid: '', editId: '' }),
        releaseMbid,
      },
    }));
    await runRow(albumId, 'Attaching release…', async () => {
      const result = await attachPickedReleaseToAlbum({ albumId, releaseMbid });
      if (result.attached) {
        await onReload();
        return;
      }
      setLookup((current) => ({
        ...current,
        [albumId]:
          result.reason === 'release_not_found'
            ? 'MusicBrainz has no release with that MBID'
            : result.reason === 'album_already_matched'
              ? 'This album is already matched to a release'
              : 'Could not attach that release',
      }));
    });
  }

  return (
    <InboxSection
      inboxClass="missing"
      activeClass={activeClass}
      title="MusicBrainz has no release for this album"
      channel="TOOL"
      total={total}
      shown={rows.length}
      pending={pending}
      description="Biggest first: the count is library tracks adding the release would unblock (the Overview's count), then the album's own size. Pre-check before Harmony — it asks MusicBrainz whether the album, its release group or its recordings already exist, and lists what Harmony will likely get wrong. Confirming with the new release MBID attaches it and measures what you corrected. Ambiguous barcodes stay a hand pick among actual MusicBrainz releases."
    >
      {rows.map((album) => {
        const form = forms[album.albumId] ?? { releaseMbid: '', editId: '' };
        const ambiguous = album.reason === AMBIGUOUS_BARCODE_REASON;
        const hits = liveHits[album.albumId] ?? album.barcodeHits;
        const lookupState = lookup[album.albumId];
        const state = row(album.albumId);
        const checked = prechecks[album.albumId] ?? album.precheck;
        const prepared = seeds[album.albumId] ?? album.seed;
        const evidence = (
          <>
            <span
              className="mono inbox-count"
              title="Library tracks adding this release would unblock"
            >
              {album.libraryTracks ?? '?'}
            </span>
            <span className="min-w-0">
              <span className="flex items-baseline gap-2">
                <span className="block truncate">{album.albumTitle}</span>
                {ambiguous && <ChannelBadge channel="HAND" />}
              </span>
              <span className="block text-[11px] text-[var(--ink-2)]">
                {album.libraryTracks === null
                  ? "couldn't count library tracks · "
                  : `${album.libraryTracks} library track(s) unblocked · `}
                {album.tracks} on the album · {album.year ? `${album.year} · ` : ''}
                {album.reason}
                {album.unanchored < album.tracks &&
                  ` · ${album.tracks - album.unanchored} track(s) already reach a recording elsewhere`}
                {album.ledger?.releaseMbid && ` · ${album.ledger.releaseMbid}`}
              </span>
              {!album.ledger && album.previous && <PreviousSubmission previous={album.previous} />}
              {!album.ledger && <PrecheckSummary precheck={checked} />}
              <RowActionStatus row={state} />
            </span>
          </>
        );
        const links = (
          <>
            {prepared && !album.ledger && (
              <SeedOnMusicBrainzForm
                albumId={album.albumId}
                plan={prepared.plan}
                onSeeded={seeded}
              />
            )}
            <a className="act" href={album.harmony} target="_blank" rel="noreferrer">
              Harmony
            </a>
            <a
              className="act"
              href={`https://open.spotify.com/album/${album.albumId}`}
              target="_blank"
              rel="noreferrer"
            >
              Spotify
            </a>
            {ambiguous && album.upc && (
              <a
                className="act"
                href={barcodeReleaseSearchUrl(album.upc)}
                target="_blank"
                rel="noreferrer"
              >
                MusicBrainz
              </a>
            )}
          </>
        );

        if (album.ledger) {
          return (
            <InboxRow
              key={album.albumId}
              data-inbox-album={album.albumId}
              evidence={
                <>
                  {evidence}
                  <span className="album-meta">{album.ledger.label}</span>
                </>
              }
              links={links}
              action={
                <button
                  className="act"
                  disabled={state.busy}
                  onClick={() => recheck(album.albumId)}
                >
                  Recheck
                </button>
              }
            />
          );
        }

        return (
          <ConfirmDisclosure
            key={album.albumId}
            data-inbox-album={album.albumId}
            evidence={evidence}
            links={links}
            label={ambiguous ? 'Pick…' : 'Confirm…'}
            extraAction={
              <>
                <button
                  className="act"
                  disabled={state.busy}
                  onClick={() => precheck(album.albumId)}
                >
                  {checked ? 'Pre-check again' : 'Pre-check'}
                </button>
                <button
                  className="act"
                  disabled={state.busy}
                  onClick={() => prepareSeed(album.albumId)}
                  title="Work out which existing recordings to pre-fill, for Seed on MusicBrainz"
                >
                  {prepared ? 'Prepare seed again' : 'Prepare seed'}
                </button>
              </>
            }
          >
            <div className="mb-4">
              {checked ? (
                <ReleasePrecheckPanel precheck={checked} />
              ) : (
                <p className="absent">
                  Not pre-checked yet. Pre-check before opening Harmony: it looks for this album,
                  its release group and its recordings on MusicBrainz first.
                </p>
              )}
              <div className="mt-4">
                <p className="eyebrow mb-1">Seed on MusicBrainz</p>
                {prepared ? (
                  <>
                    <SeedPreview seed={prepared} />
                    <div className="mt-2">
                      <SeedOnMusicBrainzForm
                        albumId={album.albumId}
                        plan={prepared.plan}
                        onSeeded={seeded}
                      />
                    </div>
                  </>
                ) : (
                  <p className="absent">
                    Not prepared yet. Prepare seed works out which existing recordings to pre-fill
                    (by ISRC, or by position in an existing edition), so the release editor opens
                    with them already chosen instead of picking each by hand.
                  </p>
                )}
              </div>
              <p className="mt-3">
                Then enter the edit (from the seed above, or{' '}
                <a href={album.harmony} target="_blank" rel="noreferrer">
                  Harmony
                </a>
                ) and confirm below with the new release MBID so the album attaches and the
                corrections are measured.
              </p>
            </div>
            {ambiguous && (
              <div className="mb-4">
                <MbPicker
                  seed={album.upc ?? ''}
                  hits={hits}
                  loading={lookupState === 'loading'}
                  status={
                    lookupState && lookupState !== 'loading' && lookupState !== ''
                      ? lookupState
                      : null
                  }
                  pickedMbid={form.releaseMbid}
                  busy={state.busy}
                  pickNote="A cached pick attaches the album. A live, uncached hit only fills the confirmation form and does not write the cache."
                  onPick={(mbid) => pick(album.albumId, mbid)}
                  onLookup={album.upc ? () => lookUp(album.albumId, album.upc ?? '') : undefined}
                />
              </div>
            )}
            <div className="toolbar px-0">
              <input
                className="mono min-w-52 flex-1"
                placeholder="release MBID (optional)"
                value={form.releaseMbid}
                onChange={(event) =>
                  setForms((current) => ({
                    ...current,
                    [album.albumId]: { ...form, releaseMbid: event.target.value },
                  }))
                }
              />
              <input
                className="mono w-40"
                placeholder="edit ID (optional)"
                value={form.editId}
                onChange={(event) =>
                  setForms((current) => ({
                    ...current,
                    [album.albumId]: { ...form, editId: event.target.value },
                  }))
                }
              />
              <button
                className="act"
                data-variant="primary"
                disabled={state.busy}
                onClick={() => confirm(album.albumId)}
              >
                Confirm submission
              </button>
            </div>
          </ConfirmDisclosure>
        );
      })}
      <LoadMoreRows shown={rows.length} total={total} busy={busy} onMore={onLoadMore} />
    </InboxSection>
  );
}
