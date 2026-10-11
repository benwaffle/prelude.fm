import type { SavedTrack } from '@spotify/web-api-ts-sdk';

const DB_VERSION = 2;
const STORE_NAME = 'likedSongs';
const META_STORE = 'metadata';
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
let legacyCleanupStarted = false;

export function likedSongsDatabaseName(userId: string) {
  return `SpotifyCache:${userId}`;
}

export interface CachedLikedSongs {
  tracks: SavedTrack[];
  isStale: boolean;
}

function openDB(userId: string): Promise<IDBDatabase> {
  if (!legacyCleanupStarted) {
    legacyCleanupStarted = true;
    indexedDB.deleteDatabase('SpotifyCache');
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(likedSongsDatabaseName(userId), DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      db.createObjectStore(STORE_NAME, { keyPath: 'track.id' });

      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
    };
  });
}

export async function getCachedLikedSongs(userId: string): Promise<CachedLikedSongs | null> {
  try {
    const db = await openDB(userId);

    const metaTx = db.transaction(META_STORE, 'readonly');
    const metaStore = metaTx.objectStore(META_STORE);
    const metaRequest = metaStore.get('lastFetch');

    const metadata = await new Promise<{ timestamp: number; total: number } | null>((resolve) => {
      metaRequest.onsuccess = () => resolve(metaRequest.result);
      metaRequest.onerror = () => resolve(null);
    });

    if (!metadata) {
      return null;
    }

    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();

    const tracks = await new Promise<SavedTrack[] | null>((resolve) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });

    if (!tracks) return null;

    return {
      tracks,
      isStale: Date.now() - metadata.timestamp >= CACHE_TTL,
    };
  } catch {
    return null;
  }
}

export async function setCachedLikedSongs(userId: string, tracks: SavedTrack[]): Promise<void> {
  try {
    const db = await openDB(userId);
    const tx = db.transaction([STORE_NAME, META_STORE], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const metaStore = tx.objectStore(META_STORE);

    store.clear();
    for (const track of tracks) {
      store.put(track);
    }
    metaStore.put({ timestamp: Date.now(), total: tracks.length }, 'lastFetch');
  } catch (e) {
    console.error('Failed to cache liked songs:', e);
  }
}
