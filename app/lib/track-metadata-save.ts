import { db, type DatabaseExecutor } from '@/lib/db';
import {
  composer,
  recordingTrackV2,
  recordingV2,
  spotifyAlbum,
  spotifyArtist,
  spotifyTrack,
  trackArtists,
  trackWorkPartV2,
  workPartV2,
} from '@/lib/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { upsertWork } from '@/app/admin/actions/spotify-utils';
import { toRoman } from '@/lib/classical-normalization';
import { ensureWorkCatalogV2 } from '@/lib/work-parts-v2';
import { refreshRecordingPopularity } from '@/lib/recording-popularity';

export interface TrackMetadataSaveInput {
  preserveExistingWork?: boolean;
  album: {
    id: string;
    name: string;
    release_date: string;
    popularity: number | null;
    images: { url: string; width: number; height: number }[];
    inSpotifyAlbumsTable: boolean;
  };
  track: {
    id: string;
    name: string;
    uri: string;
    duration_ms: number;
    disc_number: number;
    track_number: number;
    popularity: number;
    inSpotifyTracksTable: boolean;
    /**
     * Spotify reports the ISRC on the track payload we already fetch, and it is
     * the join key into MusicBrainz. Capturing it here means the library does
     * not have to be walked again later to recover something we were handed.
     * Optional: callers that do not have it leave the stored value alone.
     */
    isrc?: string | null;
  };
  artists: { id: string; name: string; inSpotifyArtistsTable: boolean; composerId?: number }[];
  composerArtist?: { id: string; name: string };
  metadata: {
    composerArtistId: string;
    composerName: string;
    formalName: string;
    nickname: string | null;
    catalogSystem: string | null;
    catalogNumber: string | null;
    form: string | null;
    movementNumber: number;
    movementName: string | null;
    yearComposed: number | null;
  };
}

export interface TrackMetadataSaveResult {
  success: true;
  workId: number;
  movementId: number;
  recordingId: number;
  composerId: number;
}

export async function saveTrackMetadataInternal(
  data: TrackMetadataSaveInput,
  database?: DatabaseExecutor,
): Promise<TrackMetadataSaveResult> {
  if (!database) {
    return db.transaction((transaction) => saveTrackMetadataInternal(data, transaction));
  }
  const { album, track, artists, composerArtist, metadata } = data;

  const albumPromise = database
    .insert(spotifyAlbum)
    .values({
      spotifyId: album.id,
      title: album.name,
      year: album.release_date ? parseInt(album.release_date.split('-')[0]) : null,
      images: album.images,
      popularity: album.popularity || null,
    })
    .onConflictDoUpdate({
      target: spotifyAlbum.spotifyId,
      set: {
        title: album.name,
        year: album.release_date ? parseInt(album.release_date.split('-')[0]) : null,
        images: album.images,
        popularity: album.popularity || null,
      },
    });

  const artistPromises = artists.map((artist) =>
    database
      .insert(spotifyArtist)
      .values({
        spotifyId: artist.id,
        name: artist.name,
        popularity: null,
        images: null,
      })
      .onConflictDoNothing(),
  );

  if (composerArtist && !artists.some((artist) => artist.id === composerArtist.id)) {
    artistPromises.push(
      database
        .insert(spotifyArtist)
        .values({
          spotifyId: composerArtist.id,
          name: composerArtist.name,
          popularity: null,
          images: null,
        })
        .onConflictDoNothing(),
    );
  }

  await Promise.all([albumPromise, ...artistPromises]);

  let composerId = artists.find((a) => a.id === metadata.composerArtistId)?.composerId;

  if (!composerId) {
    const [existing] = await database
      .select()
      .from(composer)
      .where(eq(composer.spotifyArtistId, metadata.composerArtistId))
      .limit(1);

    if (existing) {
      composerId = existing.id;
    } else {
      const result = await database
        .insert(composer)
        .values({
          name: metadata.composerName,
          spotifyArtistId: metadata.composerArtistId,
        })
        .returning({ id: composer.id });
      composerId = result[0].id;
    }
  }

  // Only write the ISRC when the caller actually has one, so a path that does
  // not carry it cannot erase a value another path already stored.
  const isrcValue = track.isrc === undefined ? {} : { isrc: track.isrc };

  await database
    .insert(spotifyTrack)
    .values({
      spotifyId: track.id,
      title: track.name,
      trackNumber: track.track_number,
      discNumber: track.disc_number,
      durationMs: track.duration_ms,
      popularity: track.popularity,
      spotifyAlbumId: album.id,
      ...isrcValue,
    })
    .onConflictDoUpdate({
      target: spotifyTrack.spotifyId,
      set: {
        title: track.name,
        trackNumber: track.track_number,
        discNumber: track.disc_number,
        durationMs: track.duration_ms,
        popularity: track.popularity,
        spotifyAlbumId: album.id,
        ...isrcValue,
      },
    });

  await Promise.all(
    artists.map((artist) =>
      database
        .insert(trackArtists)
        .values({
          spotifyTrackId: track.id,
          spotifyArtistId: artist.id,
        })
        .onConflictDoNothing(),
    ),
  );

  const workId = await upsertWork(
    {
      composerId,
      title: metadata.formalName,
      nickname: metadata.nickname,
      catalogSystem: metadata.catalogSystem,
      catalogNumber: metadata.catalogNumber,
      yearComposed: metadata.yearComposed,
      form: metadata.form,
      preserveExisting: data.preserveExistingWork,
    },
    database,
  );

  await ensureWorkCatalogV2(workId, metadata.catalogSystem, metadata.catalogNumber, database);
  let [part] = await database
    .select({ id: workPartV2.id })
    .from(workPartV2)
    .where(and(eq(workPartV2.workId, workId), eq(workPartV2.position, metadata.movementNumber)))
    .limit(1);
  if (!part) {
    [part] = await database
      .insert(workPartV2)
      .values({
        workId,
        position: metadata.movementNumber,
        label: toRoman(metadata.movementNumber),
        title: metadata.movementName?.trim() || null,
      })
      .returning({ id: workPartV2.id });
  }

  let [recordingRow] = await database
    .select({ id: recordingV2.id })
    .from(recordingV2)
    .where(and(eq(recordingV2.spotifyAlbumId, album.id), eq(recordingV2.workId, workId)))
    .orderBy(
      sql`(SELECT count(*) FROM recording_track_v2 WHERE recording_id = ${recordingV2.id}) DESC`,
    )
    .limit(1);
  if (!recordingRow) {
    [recordingRow] = await database
      .insert(recordingV2)
      .values({ spotifyAlbumId: album.id, workId, popularity: null })
      .returning({ id: recordingV2.id });
  }
  const [previousMembership] = await database
    .select({ recordingId: recordingTrackV2.recordingId })
    .from(recordingTrackV2)
    .where(eq(recordingTrackV2.spotifyTrackId, track.id))
    .limit(1);
  if (previousMembership && previousMembership.recordingId !== recordingRow.id) {
    await database.delete(recordingTrackV2).where(eq(recordingTrackV2.spotifyTrackId, track.id));
  }
  await database
    .insert(recordingTrackV2)
    .values({
      recordingId: recordingRow.id,
      spotifyTrackId: track.id,
    })
    .onConflictDoNothing();
  await Promise.all(
    [recordingRow.id, previousMembership?.recordingId]
      .filter((id): id is number => id !== undefined)
      .map((id) => refreshRecordingPopularity(id, database)),
  );
  await database.delete(trackWorkPartV2).where(eq(trackWorkPartV2.spotifyTrackId, track.id));
  await database.insert(trackWorkPartV2).values({
    spotifyTrackId: track.id,
    workPartId: part.id,
    matchSource: 'manual',
    matchStatus: 'confirmed',
  });

  return {
    success: true,
    workId,
    movementId: part.id,
    recordingId: recordingRow.id,
    composerId,
  };
}
