import { and, eq, inArray } from 'drizzle-orm';
import { db, type DatabaseExecutor } from '@/lib/db';
import {
  composer,
  recordingTrackV2,
  recordingV2,
  trackWorkPartV2,
  work,
  workCatalogV2,
  workPartV2,
  metadataMigrationAudit,
} from '@/lib/db/schema';
import {
  normalizeCatalogNumber,
  normalizeCatalogSystem,
  normalizeMetadataText,
} from '@/lib/classical-normalization';
import type { ClassicalMetadataV2 } from '@/lib/classical-parser';
import { collapseCartesianPartAssignments, selectRecordingMatch } from '@/lib/recording-matching';
import { candidateIsSpecificEnough, titlesAreCompatible } from '@/lib/metadata-matching';
import { refreshRecordingPopularity } from '@/lib/recording-popularity';

export type V2TrackInput = {
  id: string;
  discNumber: number;
  trackNumber: number;
};

export type SaveParsedAlbumResult = {
  groups: number;
  confirmed: number;
  needsReview: number;
};

/**
 * Raised before the first write when a classical track on the album has no
 * work we can resolve. The caller is expected to let it abort the surrounding
 * transaction, so the album is saved whole or not at all.
 */
export class UnresolvedAlbumWorkError extends Error {
  readonly spotifyTrackIds: string[];

  constructor(spotifyAlbumId: string, unresolved: Array<{ trackId: string; describes: string }>) {
    super(
      `Album ${spotifyAlbumId} was not saved: ${unresolved.length} classical ` +
        `${unresolved.length === 1 ? 'track has' : 'tracks have'} no resolvable work (` +
        unresolved.map((item) => `${item.trackId}: ${item.describes}`).join('; ') +
        ')',
    );
    this.name = 'UnresolvedAlbumWorkError';
    this.spotifyTrackIds = unresolved.map((item) => item.trackId);
  }
}

let composerRowsPromise: Promise<Array<{ id: number; name: string }>> | null = null;

async function getComposerRows(database: DatabaseExecutor) {
  if (database !== db) {
    return database.select({ id: composer.id, name: composer.name }).from(composer);
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      composerRowsPromise ??= db.select({ id: composer.id, name: composer.name }).from(composer);
      return await composerRowsPromise;
    } catch (error) {
      composerRowsPromise = null;
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
    }
  }
  return [];
}

export async function ensureWorkCatalogV2(
  workId: number,
  system: string | null,
  number: string | null,
  database: DatabaseExecutor = db,
) {
  if (!system || !number) return;
  await database
    .insert(workCatalogV2)
    .values({
      workId,
      system,
      number,
      normalizedSystem: normalizeCatalogSystem(system),
      normalizedNumber: normalizeCatalogNumber(number),
      isPrimary: true,
    })
    .onConflictDoNothing();
}

async function resolveComposerId(
  name: string | null,
  database: DatabaseExecutor,
  availableComposers?: Array<{ id: number; name: string }>,
) {
  if (!name) return null;
  const normalizedName = normalizeMetadataText(name.split('(')[0]);
  const rows = availableComposers ?? (await getComposerRows(database));
  const exact = rows.filter((row) => normalizeMetadataText(row.name) === normalizedName);
  if (exact.length === 1) return exact[0].id;

  // Album credits and parsers often use only a composer's surname ("Mozart")
  // while the canonical row stores the full name. Accept that only when it is
  // unique, so common or ambiguous surnames remain unresolved for review.
  const requestedSurname = normalizedName.split(' ').at(-1);
  const partial = rows.filter((row) => {
    const canonicalName = normalizeMetadataText(row.name);
    const canonicalSurname = canonicalName.split(' ').at(-1);
    return (
      canonicalName.endsWith(` ${normalizedName}`) ||
      normalizedName.endsWith(` ${canonicalName}`) ||
      (requestedSurname && canonicalSurname === requestedSurname)
    );
  });
  return partial.length === 1 ? partial[0].id : null;
}

export async function resolveWorkV2(
  metadata: ClassicalMetadataV2,
  preferredWorkId?: number | null,
  database: DatabaseExecutor = db,
  availableComposers?: Array<{ id: number; name: string }>,
) {
  const composerId = await resolveComposerId(metadata.composerName, database, availableComposers);
  if (!composerId) return null;

  const [preferredWork] = preferredWorkId
    ? await database
        .select({ id: work.id, composerId: work.composerId, title: work.title })
        .from(work)
        .where(eq(work.id, preferredWorkId))
        .limit(1)
    : [];
  const compatiblePreferredWork =
    preferredWork?.composerId === composerId &&
    titlesAreCompatible(preferredWork.title, metadata.formalName) &&
    candidateIsSpecificEnough(metadata.formalName, preferredWork.title)
      ? preferredWork
      : null;

  if (metadata.catalogSystem && metadata.catalogNumber) {
    const candidates = await database
      .select({ id: work.id, title: work.title })
      .from(workCatalogV2)
      .innerJoin(work, eq(workCatalogV2.workId, work.id))
      .where(
        and(
          eq(work.composerId, composerId),
          eq(workCatalogV2.normalizedSystem, normalizeCatalogSystem(metadata.catalogSystem)),
          eq(workCatalogV2.normalizedNumber, normalizeCatalogNumber(metadata.catalogNumber)),
        ),
      );
    const audits =
      candidates.length > 0
        ? await database
            .select({
              sourceId: metadataMigrationAudit.sourceId,
              targetId: metadataMigrationAudit.targetId,
            })
            .from(metadataMigrationAudit)
            .where(
              and(
                eq(metadataMigrationAudit.entityType, 'work'),
                inArray(
                  metadataMigrationAudit.sourceId,
                  candidates.map((candidate) => String(candidate.id)),
                ),
              ),
            )
        : [];
    const targetBySource = new Map(audits.map((audit) => [audit.sourceId, audit.targetId]));
    const canonicalCandidates = [
      ...new Map(
        candidates.map((candidate) => {
          const mapped = targetBySource.get(String(candidate.id));
          const id = mapped ? Number(mapped) : candidate.id;
          return [id, { ...candidate, id }];
        }),
      ).values(),
    ];
    const title = normalizeMetadataText(metadata.formalName);
    const exact = canonicalCandidates.filter(
      (candidate) => normalizeMetadataText(candidate.title) === title,
    );
    if (exact.length === 1) return exact[0].id;
    if (compatiblePreferredWork) {
      const preferredAudit = await database
        .select({ targetId: metadataMigrationAudit.targetId })
        .from(metadataMigrationAudit)
        .where(
          and(
            eq(metadataMigrationAudit.entityType, 'work'),
            eq(metadataMigrationAudit.sourceId, String(compatiblePreferredWork.id)),
          ),
        )
        .limit(1);
      const canonicalPreferredId = preferredAudit[0]?.targetId
        ? Number(preferredAudit[0].targetId)
        : compatiblePreferredWork.id;
      if (
        canonicalCandidates.length === 0 ||
        canonicalCandidates.some((candidate) => candidate.id === canonicalPreferredId)
      ) {
        return canonicalPreferredId;
      }
    }
    return null;
  }

  const candidates = await database
    .select({ id: work.id, title: work.title })
    .from(work)
    .where(eq(work.composerId, composerId));
  const title = normalizeMetadataText(metadata.formalName);
  const exact = candidates.filter((candidate) => normalizeMetadataText(candidate.title) === title);
  if (exact.length === 1) return exact[0].id;
  if (compatiblePreferredWork) return compatiblePreferredWork.id;
  return null;
}

async function resolveWorkPart(
  workId: number,
  candidate: ClassicalMetadataV2['parts'][number],
  preferredPartId?: number,
  database: DatabaseExecutor = db,
) {
  candidate = {
    ...candidate,
    label: candidate.label?.trim() || null,
    title: candidate.title?.trim() || null,
  };
  const existing = await database.select().from(workPartV2).where(eq(workPartV2.workId, workId));
  const normalizedTitle = normalizeMetadataText(candidate.title);
  const normalizedLabel = normalizeMetadataText(candidate.label);
  const preserveCanonicalPosition = async (part: (typeof existing)[number]) => {
    if ((!part.label && candidate.label) || (!part.title && candidate.title)) {
      await database
        .update(workPartV2)
        .set({ label: part.label ?? candidate.label, title: part.title ?? candidate.title })
        .where(eq(workPartV2.id, part.id));
    }
    return { id: part.id, status: 'confirmed' as const };
  };
  const exact =
    normalizedTitle || normalizedLabel
      ? existing.filter(
          (part) =>
            normalizeMetadataText(part.title) === normalizedTitle &&
            normalizeMetadataText(part.label) === normalizedLabel,
        )
      : [];
  if (exact.length === 1) return preserveCanonicalPosition(exact[0]);

  // A complete printed label identifies the canonical leaf. Spotify often
  // supplies shorter or longer title variants for that same movement.
  const labelMatches = normalizedLabel
    ? existing.filter((part) => normalizeMetadataText(part.label) === normalizedLabel)
    : [];
  if (labelMatches.length === 1) return preserveCanonicalPosition(labelMatches[0]);

  const titleMatches = normalizedTitle
    ? existing.filter((part) => normalizeMetadataText(part.title) === normalizedTitle)
    : [];
  if (titleMatches.length === 1) return preserveCanonicalPosition(titleMatches[0]);

  const preferredPart = preferredPartId
    ? existing.find((part) => part.id === preferredPartId)
    : undefined;
  if (
    preferredPart &&
    ((normalizedLabel && normalizeMetadataText(preferredPart.label) === normalizedLabel) ||
      (normalizedTitle &&
        preferredPart.title &&
        titlesAreCompatible(preferredPart.title, candidate.title ?? '')))
  ) {
    return preserveCanonicalPosition(preferredPart);
  }

  const occupant = existing.find((part) => part.position === candidate.position);
  const occupantHasMatchingLabel =
    occupant && normalizedLabel && normalizeMetadataText(occupant.label) === normalizedLabel;
  const occupantHasCompatibleTitle =
    occupant &&
    normalizedTitle &&
    normalizeMetadataText(occupant.title) &&
    titlesAreCompatible(occupant.title ?? '', candidate.title ?? '');
  if (occupant && (occupantHasMatchingLabel || occupantHasCompatibleTitle)) {
    return preserveCanonicalPosition(occupant);
  }

  const usedPositions = new Set(existing.map((part) => part.position));
  let position = candidate.position;
  let status: 'confirmed' | 'needs_review' = 'confirmed';
  if (occupant) {
    position = Math.max(0, ...usedPositions) + 1;
    while (usedPositions.has(position)) position += 1;
    status = 'needs_review';
  }
  const [created] = await database
    .insert(workPartV2)
    .values({
      workId,
      position,
      label: candidate.label,
      title: candidate.title,
    })
    .returning({ id: workPartV2.id });
  return { id: created.id, status };
}

async function reconcileRecording(
  spotifyAlbumId: string,
  workId: number,
  trackIds: string[],
  database: DatabaseExecutor,
) {
  const candidates = await database
    .select({ id: recordingV2.id })
    .from(recordingV2)
    .where(and(eq(recordingV2.spotifyAlbumId, spotifyAlbumId), eq(recordingV2.workId, workId)));
  const memberships: Array<{ id: number; trackIds: string[] }> = [];
  for (const candidate of candidates) {
    const members = await database
      .select({ id: recordingTrackV2.spotifyTrackId })
      .from(recordingTrackV2)
      .where(eq(recordingTrackV2.recordingId, candidate.id));
    memberships.push({ id: candidate.id, trackIds: members.map((member) => member.id) });
  }
  let recordingId = selectRecordingMatch(trackIds, memberships);
  if (!recordingId) {
    const [created] = await database
      .insert(recordingV2)
      .values({ spotifyAlbumId, workId, popularity: null })
      .returning({ id: recordingV2.id });
    recordingId = created.id;
  }
  const previousMemberships =
    trackIds.length > 0
      ? await database
          .select({ recordingId: recordingTrackV2.recordingId })
          .from(recordingTrackV2)
          .where(inArray(recordingTrackV2.spotifyTrackId, trackIds))
      : [];
  await database.delete(recordingTrackV2).where(eq(recordingTrackV2.recordingId, recordingId));
  if (trackIds.length > 0) {
    await database
      .delete(recordingTrackV2)
      .where(inArray(recordingTrackV2.spotifyTrackId, trackIds));
    await database.insert(recordingTrackV2).values(
      trackIds.map((spotifyTrackId) => ({
        recordingId: recordingId!,
        spotifyTrackId,
      })),
    );
  }
  await Promise.all(
    [...new Set([recordingId, ...previousMemberships.map((row) => row.recordingId)])].map((id) =>
      refreshRecordingPopularity(id, database),
    ),
  );
  return recordingId;
}

export async function saveParsedAlbumV2(
  spotifyAlbumId: string,
  tracks: V2TrackInput[],
  parsed: ClassicalMetadataV2[],
  database?: DatabaseExecutor,
): Promise<SaveParsedAlbumResult> {
  if (!database) {
    return db.transaction((transaction) =>
      saveParsedAlbumV2(spotifyAlbumId, tracks, parsed, transaction),
    );
  }
  const currentAssignments =
    tracks.length > 0
      ? await database
          .select({
            spotifyTrackId: recordingTrackV2.spotifyTrackId,
            workId: recordingV2.workId,
          })
          .from(recordingTrackV2)
          .innerJoin(recordingV2, eq(recordingTrackV2.recordingId, recordingV2.id))
          .where(
            inArray(
              recordingTrackV2.spotifyTrackId,
              tracks.map((track) => track.id),
            ),
          )
      : [];
  const currentWorkByTrackId = new Map(
    currentAssignments.map((assignment) => [assignment.spotifyTrackId, assignment.workId]),
  );
  const currentPartAssignments =
    tracks.length > 0
      ? await database
          .select({
            spotifyTrackId: trackWorkPartV2.spotifyTrackId,
            partId: workPartV2.id,
            position: workPartV2.position,
          })
          .from(trackWorkPartV2)
          .innerJoin(workPartV2, eq(trackWorkPartV2.workPartId, workPartV2.id))
          .where(
            inArray(
              trackWorkPartV2.spotifyTrackId,
              tracks.map((track) => track.id),
            ),
          )
      : [];
  const currentPartsByTrackId = new Map<string, Array<{ id: number; position: number }>>();
  for (const assignment of currentPartAssignments) {
    const parts = currentPartsByTrackId.get(assignment.spotifyTrackId) ?? [];
    parts.push({ id: assignment.partId, position: assignment.position });
    currentPartsByTrackId.set(assignment.spotifyTrackId, parts);
  }
  for (const parts of currentPartsByTrackId.values()) {
    parts.sort((left, right) => left.position - right.position);
  }
  const resolved: Array<{
    track: V2TrackInput;
    metadata: ClassicalMetadataV2;
    workId: number | null;
  }> = [];
  const availableComposers = await database
    .select({ id: composer.id, name: composer.name })
    .from(composer);
  for (let index = 0; index < tracks.length; index++) {
    const track = tracks[index];
    resolved.push({
      track,
      metadata: parsed[index],
      workId: parsed[index]?.isClassical
        ? await resolveWorkV2(
            parsed[index],
            currentWorkByTrackId.get(track.id),
            database,
            availableComposers,
          )
        : null,
    });
  }
  // Publishing only the tracks whose work resolved strands the rest. The base
  // save has already written a provisional work, part and recording membership
  // for every track in the batch, and reconcileRecording replaces a
  // recording's whole membership with the resolved subgroup — so the tracks
  // left out come back with a part link and no recording, invisible to a
  // reader that joins through one. Fail the album before the first
  // reconciliation and let the shared transaction roll the batch back: the
  // tracks stay queued with a stated reason instead of becoming orphans.
  const unresolved = resolved.filter((item) => item.metadata?.isClassical && !item.workId);
  if (unresolved.length > 0) {
    throw new UnresolvedAlbumWorkError(
      spotifyAlbumId,
      unresolved.map((item) => ({
        trackId: item.track.id,
        describes: [item.metadata.composerName, item.metadata.formalName]
          .filter(Boolean)
          .join(' — '),
      })),
    );
  }

  const groups = new Map<string, typeof resolved>();
  const groupRepresentatives: Array<{
    key: string;
    workId: number;
    tokens: Set<string>;
    maxPartPosition: number;
  }> = [];
  for (const item of resolved) {
    if (!item.metadata?.isClassical || !item.workId || !item.metadata.recordingGroup) continue;
    const normalizedGroup = normalizeMetadataText(item.metadata.recordingGroup);
    const tokens = new Set(normalizedGroup.split(' ').filter(Boolean));
    const firstPartPosition = Math.min(
      ...item.metadata.parts.map((part) => part.position),
      Number.POSITIVE_INFINITY,
    );
    const similar = groupRepresentatives.find((representative) => {
      if (representative.workId !== item.workId) return false;
      const intersection = [...tokens].filter((token) => representative.tokens.has(token)).length;
      const union = new Set([...tokens, ...representative.tokens]).size;
      const isSequentialContinuation =
        Number.isFinite(firstPartPosition) &&
        firstPartPosition > representative.maxPartPosition &&
        firstPartPosition - representative.maxPartPosition <= 2;
      return (union > 0 && intersection / union >= 0.55) || isSequentialContinuation;
    });
    const key = similar?.key ?? `${item.workId}:${normalizedGroup}`;
    const maxPartPosition = Math.max(
      ...item.metadata.parts.map((part) => part.position),
      firstPartPosition,
    );
    if (similar) similar.maxPartPosition = Math.max(similar.maxPartPosition, maxPartPosition);
    else groupRepresentatives.push({ key, workId: item.workId, tokens, maxPartPosition });
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  let confirmed = 0;
  let needsReview = 0;
  for (const items of groups.values()) {
    const workId = items[0].workId!;
    const ordered = [...items].sort(
      (a, b) =>
        a.track.discNumber - b.track.discNumber || a.track.trackNumber - b.track.trackNumber,
    );
    const collapsedPartSets = collapseCartesianPartAssignments(
      ordered.map((item) => item.metadata.parts),
    );
    ordered.forEach((item, index) => {
      item.metadata.parts = collapsedPartSets[index];
    });
    await reconcileRecording(
      spotifyAlbumId,
      workId,
      ordered.map((item) => item.track.id),
      database,
    );
    for (const item of ordered) {
      if (item.metadata.parts.length === 0) {
        await database
          .update(trackWorkPartV2)
          .set({ matchStatus: 'needs_review' })
          .where(eq(trackWorkPartV2.spotifyTrackId, item.track.id));
        needsReview++;
        continue;
      }
      const links = new Map<number, typeof trackWorkPartV2.$inferInsert>();
      const preferredParts = currentPartsByTrackId.get(item.track.id) ?? [];
      for (let partIndex = 0; partIndex < item.metadata.parts.length; partIndex++) {
        const part = item.metadata.parts[partIndex];
        const resolvedPart = await resolveWorkPart(
          workId,
          part,
          preferredParts.length === item.metadata.parts.length
            ? preferredParts[partIndex]?.id
            : undefined,
          database,
        );
        links.set(resolvedPart.id, {
          spotifyTrackId: item.track.id,
          workPartId: resolvedPart.id,
          startMs: null,
          endMs: null,
          matchSource: 'parser' as const,
          matchStatus: resolvedPart.status,
        });
        if (resolvedPart.status === 'confirmed') confirmed++;
        else needsReview++;
      }
      await database
        .delete(trackWorkPartV2)
        .where(eq(trackWorkPartV2.spotifyTrackId, item.track.id));
      await database.insert(trackWorkPartV2).values([...links.values()]);
    }
  }
  return { groups: groups.size, confirmed, needsReview };
}
