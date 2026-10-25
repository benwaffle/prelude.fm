import { asc, eq, gte, min } from 'drizzle-orm';
import { db } from '../db';
import { spotifyAlbum } from '../db/schema';

// The Inbox, the readiness funnel and the Albums tab read the library this many albums at a time,
// in Spotify ID order. The Spotify crawl makes the library ~300k albums and 5M tracks, and Turso
// bills every row read, so no admin view reads all of it; each says which albums it covers.
export const ALBUM_WINDOW_SIZE = 300;

export type AlbumWindow = {
  /** The albums read, in Spotify ID order. */
  albumIds: string[];
  /** The first album's ID; null when there are no albums from there on. */
  from: string | null;
  /** Where the next window starts; null on the last one. */
  next: string | null;
};

/** What the page is shown of the window: not the IDs, which can be many. */
export type AlbumWindowView = Omit<AlbumWindow, 'albumIds'> & { albums: number; size: number };

export function albumWindowView(window: AlbumWindow): AlbumWindowView {
  return {
    from: window.from,
    next: window.next,
    albums: window.albumIds.length,
    size: ALBUM_WINDOW_SIZE,
  };
}

/** `from` inclusive; null starts at the first album. Reads one index entry per album. */
export async function readAlbumWindow(
  from: string | null = null,
  size = ALBUM_WINDOW_SIZE,
): Promise<AlbumWindow> {
  const rows = await db
    .select({ id: spotifyAlbum.spotifyId })
    .from(spotifyAlbum)
    .where(from ? gte(spotifyAlbum.spotifyId, from) : undefined)
    .orderBy(asc(spotifyAlbum.spotifyId))
    .limit(size + 1);
  const albumIds = rows.slice(0, size).map((row) => row.id);
  return { albumIds, from: albumIds[0] ?? null, next: rows[size]?.id ?? null };
}

/** The window that starts at the release's album, so a link to it lands on its row. */
export async function albumOfRelease(releaseMbid: string): Promise<string | null> {
  const [row] = await db
    .select({ id: min(spotifyAlbum.spotifyId) })
    .from(spotifyAlbum)
    .where(eq(spotifyAlbum.mbReleaseId, releaseMbid));
  return row?.id ?? null;
}
