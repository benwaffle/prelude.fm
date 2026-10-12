import type { Track } from '@spotify/web-api-ts-sdk';

/** The browser's player and the Web API describe a track differently; both are read into this. */
export interface NowPlayingTrack {
  /** Null for what Spotify plays without a catalogue id (a local file). */
  id: string | null;
  uri: string;
  /** Spotify may play a relinked copy of the track we asked for. */
  linkedFromUri: string | null;
  name: string;
  albumId: string | null;
  albumName: string;
  cover: string | null;
  durationMs: number;
}

/** Its album carries a URI but no id. */
export function fromSdkTrack(track: Spotify.Track): NowPlayingTrack {
  return {
    id: track.id,
    uri: track.uri,
    linkedFromUri: track.linked_from?.uri ?? null,
    name: track.name,
    albumId: track.album.uri.split(':')[2] || null,
    albumName: track.album.name,
    cover: track.album.images[0]?.url ?? null,
    durationMs: track.duration_ms,
  };
}

export function fromWebApiTrack(track: Track): NowPlayingTrack {
  return {
    id: track.id,
    uri: track.uri,
    linkedFromUri: track.linked_from?.uri ?? null,
    name: track.name,
    albumId: track.album?.id ?? null,
    albumName: track.album?.name ?? '',
    cover: track.album?.images?.[0]?.url ?? null,
    durationMs: track.duration_ms,
  };
}

export function trackUris(track: NowPlayingTrack | null): string[] {
  if (!track) return [];
  return track.linkedFromUri ? [track.uri, track.linkedFromUri] : [track.uri];
}

export function sameTrack(left: NowPlayingTrack | null, right: NowPlayingTrack | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (Object.keys(left) as (keyof NowPlayingTrack)[]).every((key) => left[key] === right[key]);
}
