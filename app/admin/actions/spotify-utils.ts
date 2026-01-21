import type {
  SpotifyAlbumRow,
  SpotifyArtistRow,
  SpotifyTrackRow,
  ComposerRow,
  MovementRow,
  TrackMovementRow,
  WorkRow,
  RecordingRow,
} from './schema-types';
import { db } from '@/lib/db';
import { composer, movement, recording, trackMovement, work } from '@/lib/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

export async function upsertWork(data: {
  composerId: number;
  title: string;
  nickname: string | null;
  catalogSystem: string | null;
  catalogNumber: string | null;
  yearComposed: number | null;
  form: string | null;
}) {
  const { composerId, title, nickname, catalogSystem, catalogNumber, yearComposed, form } = data;
  let existingWork: WorkRow | undefined;

  if (catalogSystem && catalogNumber) {
    [existingWork] = await db
      .select()
      .from(work)
      .where(
        and(
          eq(work.composerId, composerId),
          eq(work.catalogSystem, catalogSystem),
          eq(work.catalogNumber, catalogNumber),
        ),
      )
      .limit(1);
  } else {
    [existingWork] = await db
      .select()
      .from(work)
      .where(and(eq(work.composerId, composerId), eq(work.title, title)))
      .limit(1);
  }

  if (existingWork) {
    await db
      .update(work)
      .set({
        title,
        nickname,
        catalogSystem,
        catalogNumber,
        yearComposed,
        form,
      })
      .where(eq(work.id, existingWork.id));
    return existingWork.id;
  }

  const [created] = await db
    .insert(work)
    .values({
      composerId,
      title,
      nickname,
      catalogSystem,
      catalogNumber,
      yearComposed,
      form,
    })
    .returning({ id: work.id });

  return created.id;
}

export async function upsertMovement(data: {
  workId: number;
  number: number;
  title: string | null;
}) {
  const { workId, number, title } = data;
  const [existingMovement] = await db
    .select()
    .from(movement)
    .where(and(eq(movement.workId, workId), eq(movement.number, number)))
    .limit(1);

  if (existingMovement) {
    await db.update(movement).set({ title }).where(eq(movement.id, existingMovement.id));
    return existingMovement.id;
  }

  const [created] = await db
    .insert(movement)
    .values({
      workId,
      number,
      title,
    })
    .returning({ id: movement.id });

  return created.id;
}

export async function upsertRecording(data: { spotifyAlbumId: string; workId: number }) {
  const { spotifyAlbumId, workId } = data;
  const [existingRecording] = await db
    .select()
    .from(recording)
    .where(and(eq(recording.spotifyAlbumId, spotifyAlbumId), eq(recording.workId, workId)))
    .limit(1);

  if (existingRecording) {
    return existingRecording.id;
  }

  const [created] = await db
    .insert(recording)
    .values({
      spotifyAlbumId,
      workId,
      popularity: null,
    })
    .returning({ id: recording.id });

  return created.id;
}

export async function linkTrackMovement(data: { spotifyTrackId: string; movementId: number }) {
  const { spotifyTrackId, movementId } = data;
  await db
    .insert(trackMovement)
    .values({
      spotifyTrackId,
      movementId,
      startMs: null,
      endMs: null,
    })
    .onConflictDoNothing();
}

export async function loadTrackDbContext(spotifyTrackIds: string[]) {
  if (spotifyTrackIds.length === 0) {
    return {
      trackMovementsData: [] as TrackMovementRow[],
      movementsData: [] as MovementRow[],
      worksData: [] as WorkRow[],
      composersData: [] as ComposerRow[],
      recordingsData: [] as RecordingRow[],
    };
  }

  const trackMovementRecords = await db
    .select()
    .from(trackMovement)
    .where(inArray(trackMovement.spotifyTrackId, spotifyTrackIds));

  if (trackMovementRecords.length === 0) {
    return {
      trackMovementsData: [] as TrackMovementRow[],
      movementsData: [] as MovementRow[],
      worksData: [] as WorkRow[],
      composersData: [] as ComposerRow[],
      recordingsData: [] as RecordingRow[],
    };
  }

  const movementIds = trackMovementRecords.map((tm) => tm.movementId);
  const movementsData = await db.select().from(movement).where(inArray(movement.id, movementIds));

  const workIds = movementsData.map((m) => m.workId);
  const worksData =
    workIds.length > 0 ? await db.select().from(work).where(inArray(work.id, workIds)) : [];

  const composerIds = worksData.map((w) => w.composerId);
  const composersData =
    composerIds.length > 0
      ? await db.select().from(composer).where(inArray(composer.id, composerIds))
      : [];

  const recordingsData =
    workIds.length > 0
      ? await db.select().from(recording).where(inArray(recording.workId, workIds))
      : [];

  return {
    trackMovementsData: trackMovementRecords,
    movementsData,
    worksData,
    composersData,
    recordingsData,
  };
}

export function buildTrackMetadataDbData(params: {
  trackId: string;
  artists: Array<{ id: string }>;
  existingSpotifyArtists: SpotifyArtistRow[];
  trackMovementsData: TrackMovementRow[];
  movementsData: MovementRow[];
  worksData: WorkRow[];
  composersData: ComposerRow[];
  recordingsData: RecordingRow[];
  trackRow: SpotifyTrackRow | null;
  albumRow: SpotifyAlbumRow | null;
}) {
  const {
    trackId,
    artists,
    existingSpotifyArtists,
    trackMovementsData,
    movementsData,
    worksData,
    composersData,
    recordingsData,
    trackRow,
    albumRow,
  } = params;

  const trackMovements = trackMovementsData.filter((tm) => tm.spotifyTrackId === trackId);
  const movements = movementsData.filter((m) =>
    trackMovementsData.some((tm) => tm.movementId === m.id && tm.spotifyTrackId === trackId),
  );
  const works = worksData.filter((w) =>
    movementsData.some((m) => {
      const tm = trackMovementsData.find(
        (t) => t.movementId === m.id && t.spotifyTrackId === trackId,
      );
      return tm && m.workId === w.id;
    }),
  );
  const composers = composersData.filter((c) =>
    trackMovementsData.some((tm) => {
      const mvmt = movementsData.find((m) => m.id === tm.movementId);
      const wrk = mvmt && worksData.find((w) => w.id === mvmt.workId);
      return wrk && wrk.composerId === c.id && tm.spotifyTrackId === trackId;
    }),
  );
  const recordings = recordingsData.filter((r) =>
    worksData.some((w) => {
      const mvmt = movementsData.find((m) => m.workId === w.id);
      const tm =
        mvmt &&
        trackMovementsData.find((t) => t.movementId === mvmt.id && t.spotifyTrackId === trackId);
      return tm && r.workId === w.id;
    }),
  );

  return {
    track: trackRow,
    album: albumRow,
    artists: existingSpotifyArtists.filter((a) => artists.some((ta) => ta.id === a.spotifyId)),
    composers,
    trackMovements,
    movements,
    works,
    recordings,
  };
}
