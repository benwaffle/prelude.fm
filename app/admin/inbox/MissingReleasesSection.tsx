'use client';

import { useState } from 'react';
import { useAdminFailure } from '../components/AdminFailure';
import {
  attachPickedReleaseToAlbum,
  lookupBarcodeReleaseHits,
  recordReleaseSubmission,
  recheckReleaseSubmission,
  type ContributionView,
} from '../actions/contribute';
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
  const [pending, setPending] = useState<string | null>(null);
  const busy = pending !== null;
  const { clearFailure, showFailure } = useAdminFailure();
  const [forms, setForms] = useState<Record<string, { releaseMbid: string; editId: string }>>({});
  const [liveHits, setLiveHits] = useState<Record<string, MbPickHit[]>>({});
  const [lookup, setLookup] = useState<Record<string, string | 'loading'>>({});

  async function confirm(albumId: string) {
    const form = forms[albumId] ?? { releaseMbid: '', editId: '' };
    clearFailure();
    setPending('Confirming submission…');
    try {
      await recordReleaseSubmission(albumId, form);
      await onReload();
    } catch (error) {
      showFailure(error);
    } finally {
      setPending(null);
    }
  }

  async function recheck(albumId: string) {
    clearFailure();
    setPending('Rechecking MusicBrainz…');
    try {
      await recheckReleaseSubmission(albumId);
      await onReload();
    } catch (error) {
      showFailure(error);
    } finally {
      setPending(null);
    }
  }

  async function lookUp(albumId: string, upc: string) {
    clearFailure();
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
        [albumId]: error instanceof Error ? error.message : String(error),
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
    clearFailure();
    setPending('Attaching release…');
    try {
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
    } catch (error) {
      showFailure(error);
    } finally {
      setPending(null);
    }
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
      description="Harmony seeds a release from Spotify. Ambiguous barcodes stay a hand pick among actual MusicBrainz releases."
    >
      {rows.map((album) => {
        const form = forms[album.albumId] ?? { releaseMbid: '', editId: '' };
        const ambiguous = album.reason === AMBIGUOUS_BARCODE_REASON;
        const hits = liveHits[album.albumId] ?? album.barcodeHits;
        const lookupState = lookup[album.albumId];
        const evidence = (
          <>
            <span className="mono inbox-count">{album.tracks}</span>
            <span className="min-w-0">
              <span className="flex items-baseline gap-2">
                <span className="block truncate">{album.albumTitle}</span>
                {ambiguous && <ChannelBadge channel="HAND" />}
              </span>
              <span className="block text-[11px] text-[var(--ink-2)]">
                {album.year ? `${album.year} · ` : ''}
                {album.reason}
                {album.unanchored < album.tracks &&
                  ` · ${album.tracks - album.unanchored} track(s) already reach a recording elsewhere`}
                {album.ledger?.releaseMbid && ` · ${album.ledger.releaseMbid}`}
              </span>
            </span>
          </>
        );
        const links = (
          <>
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
                <button className="act" disabled={busy} onClick={() => recheck(album.albumId)}>
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
            disabled={busy}
          >
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
                  busy={busy}
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
                disabled={busy}
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
