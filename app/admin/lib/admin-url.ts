import { type AlbumState } from './album-state';
import { type InboxFocus } from './inbox-focus';

export const ADMIN_TABS = ['inbox', 'albums', 'health'] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];

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

const ALBUM_STATES: AlbumState[] = [
  'anchored',
  'partial',
  'needs_isrcs',
  'absent',
  'ambiguous',
  'unchecked',
];

export type AdminUrlState = {
  tab: AdminTab;
  inboxClass?: InboxClass;
  focus: InboxFocus | null;
  albumFilter?: AlbumState;
};

type SearchReader = Pick<URLSearchParams, 'get'>;

export function parseAdminUrl(search: SearchReader): AdminUrlState {
  const requestedTab = search.get('tab');
  const tab = ADMIN_TABS.includes(requestedTab as AdminTab) ? (requestedTab as AdminTab) : 'inbox';
  const requestedClass = search.get('class');
  const inboxClass = INBOX_CLASSES.includes(requestedClass as InboxClass)
    ? (requestedClass as InboxClass)
    : undefined;
  const requestedFilter = search.get('filter');
  const albumFilter = ALBUM_STATES.includes(requestedFilter as AlbumState)
    ? (requestedFilter as AlbumState)
    : undefined;
  const album = search.get('album')?.trim();
  const release = search.get('release')?.trim();

  return {
    tab,
    inboxClass,
    albumFilter,
    focus: album ? { kind: 'album', id: album } : release ? { kind: 'release', id: release } : null,
  };
}

export type AdminUrlPatch = Partial<
  Record<'tab' | 'class' | 'album' | 'release' | 'filter', string | null>
>;

export function patchAdminUrl(search: URLSearchParams, patch: AdminUrlPatch): string {
  const next = new URLSearchParams(search);
  for (const [key, value] of Object.entries(patch)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  const query = next.toString();
  return query ? `?${query}` : '';
}
