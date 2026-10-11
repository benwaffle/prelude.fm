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

/** Pages for the tools that are not Inbox lists. */
export const TOOL_PAGES = ['albums', 'corrections', 'refresh-work', 'checks'] as const;
export type ToolPage = (typeof TOOL_PAGES)[number];

/** Every admin page but the home page: one per Inbox section, one per tool. */
export type AdminPage = InboxClass | ToolPage;

const ALBUM_STATES: AlbumState[] = [
  'anchored',
  'partial',
  'needs_isrcs',
  'absent',
  'ambiguous',
  'unchecked',
];

export type AdminUrlState = {
  /** Null on the home page. */
  page: AdminPage | null;
  focus: InboxFocus | null;
  albumFilter?: AlbumState;
};

type SearchReader = Pick<URLSearchParams, 'get'>;

function isOneOf<T extends string>(values: readonly T[], value: string | null): value is T {
  return values.includes(value as T);
}

/**
 * Links from before the home page replaced the tabs (`?tab=inbox&class=…`,
 * `?tab=albums`, `?tab=health`, `?tab=details&filter=…`) still land on the
 * page that now holds what they pointed at.
 */
function legacyPage(search: SearchReader): AdminPage | null {
  const requestedClass = search.get('class');
  if (isOneOf(INBOX_CLASSES, requestedClass)) return requestedClass;
  const tab = search.get('tab');
  if (tab === 'albums') return 'albums';
  if (tab === 'health') return 'checks';
  if (tab === 'details' && search.get('filter')) return 'albums';
  return null;
}

export function parseAdminUrl(search: SearchReader): AdminUrlState {
  const requestedPage = search.get('page');
  const page: AdminPage | null =
    isOneOf<AdminPage>(INBOX_CLASSES, requestedPage) || isOneOf(TOOL_PAGES, requestedPage)
      ? requestedPage
      : legacyPage(search);
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
