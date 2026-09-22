import type { MusicBrainzGapCode } from '@/lib/musicbrainz-library';
import type { AlbumState } from './album-state';
import type { InboxClass } from './admin-url';
import type { InboxFocus } from './inbox-focus';

export type AdminGapDestination =
  | { tab: 'inbox'; inboxClass: InboxClass; focus?: InboxFocus }
  | { tab: 'albums'; albumFilter?: AlbumState }
  | { tab: 'health' };

export type GapRouteContext = {
  spotifyAlbumId: string | null;
};

function albumFocus(context: GapRouteContext): InboxFocus | undefined {
  return context.spotifyAlbumId ? { kind: 'album', id: context.spotifyAlbumId } : undefined;
}

/**
 * A gap gets a route only when the destination has a real matching action.
 * Explicit nulls are intentional: they keep cache/classification gaps from
 * masquerading as MusicBrainz contribution forms.
 */
export function gapRoute(
  code: MusicBrainzGapCode,
  context: GapRouteContext,
): AdminGapDestination | null {
  switch (code) {
    case 'release-missing':
      return { tab: 'inbox', inboxClass: 'missing', focus: albumFocus(context) };
    case 'release-not-checked':
      return { tab: 'albums', albumFilter: 'unchecked' };
    case 'release-ambiguous':
      return { tab: 'inbox', inboxClass: 'missing', focus: albumFocus(context) };
    case 'release-tracklist-misaligned':
      return { tab: 'inbox', inboxClass: 'misaligned', focus: albumFocus(context) };
    case 'release-spotify-streaming-url-missing':
      return { tab: 'inbox', inboxClass: 'streaming', focus: albumFocus(context) };
    case 'release-cache-missing':
      return { tab: 'albums' };
    case 'recording-anchor-conflict':
      return { tab: 'inbox', inboxClass: 'contested' };
    case 'recording-work-missing':
      return { tab: 'inbox', inboxClass: 'work', focus: albumFocus(context) };

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
    case 'recording-credits-missing':
    case 'recording-credit-artist-missing':
      return null;
  }

  const exhaustive: never = code;
  return exhaustive;
}

export function adminGapHref(destination: AdminGapDestination): string {
  const search = new URLSearchParams({ tab: destination.tab });
  if (destination.tab === 'inbox') {
    search.set('class', destination.inboxClass);
    if (destination.focus?.kind === 'album') search.set('album', destination.focus.id);
    if (destination.focus?.kind === 'release') search.set('release', destination.focus.id);
  }
  if (destination.tab === 'albums' && destination.albumFilter) {
    search.set('filter', destination.albumFilter);
  }
  return `/admin?${search}`;
}
