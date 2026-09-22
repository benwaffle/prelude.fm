import type { AlbumRow } from './album-state';

export type InboxFocus = { kind: 'release'; id: string } | { kind: 'album'; id: string };

/** Which Inbox row an album pipeline state should jump to, if any. */
export function inboxFocusForAlbum(
  album: Pick<AlbumRow, 'id' | 'state' | 'mbReleaseId'>,
): InboxFocus | null {
  if (album.state === 'absent' || album.state === 'ambiguous' || album.state === 'unchecked') {
    return { kind: 'album', id: album.id };
  }
  if (album.mbReleaseId && (album.state === 'partial' || album.state === 'needs_isrcs')) {
    return { kind: 'release', id: album.mbReleaseId };
  }
  return null;
}
