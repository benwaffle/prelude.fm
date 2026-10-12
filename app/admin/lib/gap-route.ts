import type { MusicBrainzGapCode } from '@/lib/musicbrainz-library';
import type { AlbumState } from './album-state';
import { adminHref, type AdminPage } from './admin-url';
import type { InboxFocus } from './inbox-focus';

export type AdminGapDestination = {
  page: AdminPage;
  focus?: InboxFocus;
  albumFilter?: AlbumState;
};

export type GapRouteContext = {
  spotifyAlbumId: string | null;
};

function albumFocus(context: GapRouteContext): InboxFocus | undefined {
  return context.spotifyAlbumId ? { kind: 'album', id: context.spotifyAlbumId } : undefined;
}

// Explicit nulls keep cache/classification gaps from masquerading as MusicBrainz contribution
// forms.
export function gapRoute(
  code: MusicBrainzGapCode,
  context: GapRouteContext,
): AdminGapDestination | null {
  switch (code) {
    case 'release-missing':
      return { page: 'missing', focus: albumFocus(context) };
    case 'release-not-checked':
      return { page: 'albums', albumFilter: 'unchecked' };
    case 'release-ambiguous':
      return { page: 'missing', focus: albumFocus(context) };
    case 'release-tracklist-misaligned':
      return { page: 'misaligned', focus: albumFocus(context) };
    case 'release-spotify-streaming-url-missing':
      return { page: 'streaming', focus: albumFocus(context) };
    case 'release-cache-missing':
      return { page: 'albums' };
    case 'recording-anchor-conflict':
      return { page: 'contested' };
    case 'recording-work-missing':
      return { page: 'work', focus: albumFocus(context) };

    case 'recording-unanchored':
      // This projection cannot prove the stricter ISRC contribution eligibility.
      return null;
    case 'provider-track-not-fetched':
    case 'provider-album-not-fetched':
    case 'classification-unreviewed':
    case 'classification-uncertain':
    case 'classification-not-classical':
    case 'release-title-missing':
    case 'release-date-missing':
    case 'release-track-position-mismatch':
    case 'recording-cache-missing':
    case 'recording-stub':
    case 'recording-title-missing':
    case 'work-cache-missing':
    case 'work-stub':
    case 'work-title-missing':
    case 'work-type-missing':
    case 'work-catalogue-missing':
    case 'work-composer-missing':
    case 'composer-cache-missing':
    case 'composer-name-missing':
    case 'work-hierarchy-parent-missing':
    case 'work-hierarchy-cycle':
    case 'work-level-ambiguous':
    // Our own link stands in for a MusicBrainz one; the gap naming what MusicBrainz lacks carries
    // the route.
    case 'work-linked-by-us':
    case 'recording-credits-missing':
    case 'recording-credit-artist-missing':
      return null;
  }

  const exhaustive: never = code;
  return exhaustive;
}

export function adminGapHref(destination: AdminGapDestination): string {
  return adminHref(destination.page, destination);
}
