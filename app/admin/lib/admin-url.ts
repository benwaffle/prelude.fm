import { type AlbumState } from './album-state';
import { type InboxFocus } from './inbox-focus';

export const INBOX_CLASSES = [
  'missing',
  'misaligned',
  'isrc',
  'barcodes',
  'work',
  'streaming',
  'contested',
  'submitted',
] as const;
export type InboxClass = (typeof INBOX_CLASSES)[number];

export const TOOL_PAGES = ['albums', 'corrections', 'refresh-work', 'checks'] as const;
export type ToolPage = (typeof TOOL_PAGES)[number];

export type AdminPage = InboxClass | ToolPage;

export const PAGE_TITLE: Record<AdminPage, string> = {
  missing: 'Albums MusicBrainz has no release for',
  misaligned: 'Tracklists that do not line up',
  work: 'Recordings not linked to a work',
  contested: 'One ISRC on several recordings',
  isrc: 'Recordings missing ISRCs',
  barcodes: 'Releases with no barcode',
  streaming: 'Releases with no Spotify link',
  submitted: 'Sent to MusicBrainz, not there yet',
  albums: 'Albums in the library',
  corrections: 'Releases added through Harmony: what was corrected',
  'refresh-work': 'Refresh a work from MusicBrainz',
  checks: 'Cache checks and deployment',
};

const ALBUM_STATES: AlbumState[] = [
  'anchored',
  'partial',
  'needs_isrcs',
  'absent',
  'ambiguous',
  'unchecked',
];

export type AdminUrlState = {
  page: AdminPage | null;
  focus: InboxFocus | null;
  albumFilter?: AlbumState;
};

type SearchReader = Pick<URLSearchParams, 'get'>;

function isOneOf<T extends string>(values: readonly T[], value: string | null): value is T {
  return values.includes(value as T);
}

export function parseAdminUrl(search: SearchReader): AdminUrlState {
  const requestedPage = search.get('page');
  const page: AdminPage | null =
    isOneOf<AdminPage>(INBOX_CLASSES, requestedPage) || isOneOf(TOOL_PAGES, requestedPage)
      ? requestedPage
      : null;
  const requestedFilter = search.get('filter');
  const albumFilter = isOneOf(ALBUM_STATES, requestedFilter) ? requestedFilter : undefined;
  const album = search.get('album')?.trim();
  const release = search.get('release')?.trim();

  return {
    page,
    albumFilter,
    focus: album ? { kind: 'album', id: album } : release ? { kind: 'release', id: release } : null,
  };
}

export function adminHref(
  page: AdminPage | null,
  { focus, albumFilter }: { focus?: InboxFocus | null; albumFilter?: AlbumState } = {},
): string {
  const search = new URLSearchParams();
  if (page) search.set('page', page);
  if (focus) search.set(focus.kind, focus.id);
  if (albumFilter) search.set('filter', albumFilter);
  const query = search.toString();
  return query ? `/admin?${query}` : '/admin';
}
