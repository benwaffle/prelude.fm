import { loadEnvConfig } from '@next/env';

async function main() {
  const jsonOutput = process.argv.includes('--json');
  const allDetails = process.argv.includes('--details');
  loadEnvConfig(process.cwd());
  if (!process.env.TURSO_DATABASE_URL) {
    throw new Error('TURSO_DATABASE_URL is required');
  }

  const [{ db }, schema, drizzle, { reviewedAs }] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/db/schema'),
    import('drizzle-orm'),
    import('@/lib/db/expressions'),
  ]);
  const { and, count, countDistinct, eq, isNull, ne, not, or, sql } = drizzle;

  // A gap someone has ruled on is no longer part of the backlog. The decision
  // and its reason stay in metadata_migration_audit.
  const unreviewed = {
    emptyRecording: not(reviewedAs('recording_v2', 'unmatched_on_album', schema.recordingV2.id)),
    unnamedPart: not(reviewedAs('work_part_v2', 'no_part_name', schema.workPartV2.id)),
    composerBirthYear: not(reviewedAs('composer', 'no_birth_year', schema.composer.id)),
    workForm: not(reviewedAs('work', 'no_form', schema.work.id)),
    // A link is addressed by its track and part together, so its review is
    // recorded under the pair.
    flaggedLink: not(
      reviewedAs(
        'track_work_part_v2',
        'unresolved_link',
        sql`${schema.trackWorkPartV2.spotifyTrackId} || ':' || ${schema.trackWorkPartV2.workPartId}`,
      ),
    ),
  };
  const { canonicalCatalogKey, normalizeMetadataText, possiblePartDuplicateKey } =
    await import('@/lib/classical-normalization');

  const [
    [storedTracks],
    [linkedTracks],
    [partLinks],
    [tracksWithoutRecording],
    [recordingTracksWithoutParts],
    [crossWorkLinks],
    [duplicatePositions],
    [needsReview],
    [unclassifiedUnlinkedTracks],
    [recordingsWithoutMembers],
    [memberRecordingsWithoutPopularity],
    [recordingsWithoutMappedTracks],
    [unnamedParts],
    [composersWithoutBirthYear],
    [worksWithoutForm],
    allParts,
    allWorks,
    keptSeparate,
    recordedReviews,
  ] = await Promise.all([
    db.select({ value: count() }).from(schema.spotifyTrack),
    db
      .select({ value: countDistinct(schema.trackWorkPartV2.spotifyTrackId) })
      .from(schema.trackWorkPartV2),
    db.select({ value: count() }).from(schema.trackWorkPartV2),
    db
      .select({ value: count() })
      .from(schema.trackWorkPartV2)
      .leftJoin(
        schema.recordingTrackV2,
        eq(schema.recordingTrackV2.spotifyTrackId, schema.trackWorkPartV2.spotifyTrackId),
      )
      .where(isNull(schema.recordingTrackV2.spotifyTrackId)),
    db
      .select({ value: count() })
      .from(schema.recordingTrackV2)
      .leftJoin(
        schema.trackWorkPartV2,
        eq(schema.trackWorkPartV2.spotifyTrackId, schema.recordingTrackV2.spotifyTrackId),
      )
      .where(isNull(schema.trackWorkPartV2.spotifyTrackId)),
    db
      .select({ value: count() })
      .from(schema.trackWorkPartV2)
      .innerJoin(schema.workPartV2, eq(schema.workPartV2.id, schema.trackWorkPartV2.workPartId))
      .innerJoin(
        schema.recordingTrackV2,
        eq(schema.recordingTrackV2.spotifyTrackId, schema.trackWorkPartV2.spotifyTrackId),
      )
      .innerJoin(schema.recordingV2, eq(schema.recordingV2.id, schema.recordingTrackV2.recordingId))
      .where(ne(schema.workPartV2.workId, schema.recordingV2.workId)),
    db.select({ value: count() }).from(
      db
        .select({ workId: schema.workPartV2.workId })
        .from(schema.workPartV2)
        .groupBy(schema.workPartV2.workId, schema.workPartV2.position)
        .having(sql`count(*) > 1`)
        .as('duplicate_positions'),
    ),
    db
      .select({ value: count() })
      .from(schema.trackWorkPartV2)
      .where(and(eq(schema.trackWorkPartV2.matchStatus, 'needs_review'), unreviewed.flaggedLink)),
    db
      .select({ value: countDistinct(schema.spotifyTrack.spotifyId) })
      .from(schema.spotifyTrack)
      .leftJoin(
        schema.trackWorkPartV2,
        eq(schema.trackWorkPartV2.spotifyTrackId, schema.spotifyTrack.spotifyId),
      )
      .leftJoin(schema.matchQueue, eq(schema.matchQueue.spotifyId, schema.spotifyTrack.spotifyId))
      .where(
        and(
          isNull(schema.trackWorkPartV2.spotifyTrackId),
          or(isNull(schema.matchQueue.status), ne(schema.matchQueue.status, 'not_classical')),
        ),
      ),
    db
      .select({ value: count() })
      .from(schema.recordingV2)
      .leftJoin(
        schema.recordingTrackV2,
        eq(schema.recordingTrackV2.recordingId, schema.recordingV2.id),
      )
      .where(and(isNull(schema.recordingTrackV2.recordingId), unreviewed.emptyRecording)),
    db
      .select({ value: countDistinct(schema.recordingV2.id) })
      .from(schema.recordingV2)
      .innerJoin(
        schema.recordingTrackV2,
        eq(schema.recordingTrackV2.recordingId, schema.recordingV2.id),
      )
      .where(isNull(schema.recordingV2.popularity)),
    db
      .select({ value: count() })
      .from(schema.recordingV2)
      .where(
        and(
          sql`NOT EXISTS (
            SELECT 1
            FROM recording_track_v2 member
            JOIN track_work_part_v2 link ON link.spotify_track_id = member.spotify_track_id
            WHERE member.recording_id = ${schema.recordingV2.id}
          )`,
          unreviewed.emptyRecording,
        ),
      ),
    db
      .select({ value: count() })
      .from(schema.workPartV2)
      .where(
        and(
          sql`trim(coalesce(${schema.workPartV2.label}, '')) = ''`,
          sql`trim(coalesce(${schema.workPartV2.title}, '')) = ''`,
          unreviewed.unnamedPart,
        ),
      ),
    db
      .select({ value: count() })
      .from(schema.composer)
      .where(and(isNull(schema.composer.birthYear), unreviewed.composerBirthYear)),
    db
      .select({ value: count() })
      .from(schema.work)
      .where(and(sql`trim(coalesce(${schema.work.form}, '')) = ''`, unreviewed.workForm)),
    db
      .select({
        id: schema.workPartV2.id,
        workId: schema.workPartV2.workId,
        label: schema.workPartV2.label,
        title: schema.workPartV2.title,
      })
      .from(schema.workPartV2),
    db
      .select({
        id: schema.work.id,
        composerId: schema.work.composerId,
        title: schema.work.title,
        catalogSystem: schema.work.catalogSystem,
        catalogNumber: schema.work.catalogNumber,
      })
      .from(schema.work),
    db
      .select({ sourceId: schema.metadataMigrationAudit.sourceId })
      .from(schema.metadataMigrationAudit)
      .where(
        and(
          eq(schema.metadataMigrationAudit.entityType, 'work'),
          eq(schema.metadataMigrationAudit.decision, 'keep_separate'),
        ),
      ),
    db
      .select({ decision: schema.metadataMigrationAudit.decision, value: count() })
      .from(schema.metadataMigrationAudit)
      .where(
        drizzle.inArray(schema.metadataMigrationAudit.decision, [
          'keep_separate',
          'unmatched_on_album',
          'no_part_name',
          'no_birth_year',
          'no_form',
          'unresolved_link',
        ]),
      )
      .groupBy(schema.metadataMigrationAudit.decision),
  ]);

  const duplicatePartGroups = new Map<string, number[]>();
  for (const part of allParts) {
    const key = possiblePartDuplicateKey(part.label, part.title);
    if (!key) continue;
    const groupKey = `${part.workId}:${key}`;
    duplicatePartGroups.set(groupKey, [...(duplicatePartGroups.get(groupKey) ?? []), part.id]);
  }
  const likelyDuplicatePartGroups = [...duplicatePartGroups.entries()].filter(
    ([, ids]) => ids.length > 1,
  );

  // A work reviewed as deliberately distinct is not a duplicate candidate.
  const keepSeparateWorks = new Set(keptSeparate.map((row) => Number(row.sourceId)));
  const comparableWorks = allWorks.filter((item) => !keepSeparateWorks.has(item.id));

  // Same composer plus same canonical catalog identity is not a candidate but a
  // contradiction: two rows claim to be the same work. It also stops ingestion,
  // because upsertWork rejects the identity as ambiguous.
  const catalogIdentities = new Map<string, number[]>();
  for (const item of comparableWorks) {
    const key = canonicalCatalogKey(item.catalogSystem, item.catalogNumber);
    if (!key) continue;
    const groupKey = `${item.composerId}:${key}`;
    catalogIdentities.set(groupKey, [...(catalogIdentities.get(groupKey) ?? []), item.id]);
  }
  const duplicateCatalogGroups = [...catalogIdentities.entries()].filter(
    ([, ids]) => ids.length > 1,
  );

  // Title collisions are only worth reviewing when the catalog does not already
  // separate the rows. A composer really does write many works called
  // "Concerto for strings in G minor"; what distinguishes them is RV 152 from
  // RV 153, so flagging those as duplicates buries the genuine cases.
  const duplicateWorkGroups = new Map<string, typeof comparableWorks>();
  for (const item of comparableWorks) {
    const key = normalizeMetadataText(item.title);
    if (!key) continue;
    const groupKey = `${item.composerId}:${key}`;
    duplicateWorkGroups.set(groupKey, [...(duplicateWorkGroups.get(groupKey) ?? []), item]);
  }
  const likelyDuplicateWorkGroups = [...duplicateWorkGroups.entries()]
    .filter(([, items]) => {
      if (items.length < 2) return false;
      const keys = new Set(
        items
          .map((item) => canonicalCatalogKey(item.catalogSystem, item.catalogNumber))
          .filter(Boolean),
      );
      return keys.size < items.length;
    })
    .map(([key, items]) => [key, items.map((item) => item.id)] as const);

  const detailLimit = allDetails ? 10_000 : 5;
  const [emptyRecordingRows, unnamedPartRows, missingComposerRows, missingFormRows] =
    jsonOutput && !allDetails
      ? [[], [], [], []]
      : await Promise.all([
          db
            .select({
              recordingId: schema.recordingV2.id,
              workId: schema.recordingV2.workId,
              spotifyAlbumId: schema.recordingV2.spotifyAlbumId,
            })
            .from(schema.recordingV2)
            .where(
              and(
                sql`NOT EXISTS (
                  SELECT 1 FROM recording_track_v2 member
                  WHERE member.recording_id = ${schema.recordingV2.id}
                )`,
                unreviewed.emptyRecording,
              ),
            )
            .limit(detailLimit),
          db
            .select({
              partId: schema.workPartV2.id,
              workId: schema.workPartV2.workId,
              position: schema.workPartV2.position,
            })
            .from(schema.workPartV2)
            .where(
              and(
                sql`trim(coalesce(${schema.workPartV2.label}, '')) = ''`,
                sql`trim(coalesce(${schema.workPartV2.title}, '')) = ''`,
                unreviewed.unnamedPart,
              ),
            )
            .limit(detailLimit),
          db
            .select({ composerId: schema.composer.id, name: schema.composer.name })
            .from(schema.composer)
            .where(and(isNull(schema.composer.birthYear), unreviewed.composerBirthYear))
            .limit(detailLimit),
          db
            .select({
              workId: schema.work.id,
              composerId: schema.work.composerId,
              title: schema.work.title,
            })
            .from(schema.work)
            .where(and(sql`trim(coalesce(${schema.work.form}, '')) = ''`, unreviewed.workForm))
            .limit(detailLimit),
        ]);

  const includeDetailRows = !jsonOutput || allDetails;
  const [
    tracksWithoutRecordingRows,
    recordingTracksWithoutPartsRows,
    crossWorkLinkRows,
    duplicatePositionRows,
    unclassifiedUnlinkedTrackRows,
    memberRecordingWithoutPopularityRows,
  ] = await Promise.all([
    includeDetailRows && tracksWithoutRecording.value > 0
      ? db
          .selectDistinct({ spotifyTrackId: schema.trackWorkPartV2.spotifyTrackId })
          .from(schema.trackWorkPartV2)
          .leftJoin(
            schema.recordingTrackV2,
            eq(schema.recordingTrackV2.spotifyTrackId, schema.trackWorkPartV2.spotifyTrackId),
          )
          .where(isNull(schema.recordingTrackV2.spotifyTrackId))
          .limit(detailLimit)
      : Promise.resolve([]),
    includeDetailRows && recordingTracksWithoutParts.value > 0
      ? db
          .select({
            recordingId: schema.recordingTrackV2.recordingId,
            spotifyTrackId: schema.recordingTrackV2.spotifyTrackId,
          })
          .from(schema.recordingTrackV2)
          .leftJoin(
            schema.trackWorkPartV2,
            eq(schema.trackWorkPartV2.spotifyTrackId, schema.recordingTrackV2.spotifyTrackId),
          )
          .where(isNull(schema.trackWorkPartV2.spotifyTrackId))
          .limit(detailLimit)
      : Promise.resolve([]),
    includeDetailRows && crossWorkLinks.value > 0
      ? db
          .select({
            spotifyTrackId: schema.trackWorkPartV2.spotifyTrackId,
            partWorkId: schema.workPartV2.workId,
            recordingId: schema.recordingV2.id,
            recordingWorkId: schema.recordingV2.workId,
          })
          .from(schema.trackWorkPartV2)
          .innerJoin(schema.workPartV2, eq(schema.workPartV2.id, schema.trackWorkPartV2.workPartId))
          .innerJoin(
            schema.recordingTrackV2,
            eq(schema.recordingTrackV2.spotifyTrackId, schema.trackWorkPartV2.spotifyTrackId),
          )
          .innerJoin(
            schema.recordingV2,
            eq(schema.recordingV2.id, schema.recordingTrackV2.recordingId),
          )
          .where(ne(schema.workPartV2.workId, schema.recordingV2.workId))
          .limit(detailLimit)
      : Promise.resolve([]),
    includeDetailRows && duplicatePositions.value > 0
      ? db
          .select({
            workId: schema.workPartV2.workId,
            position: schema.workPartV2.position,
            rows: count(),
          })
          .from(schema.workPartV2)
          .groupBy(schema.workPartV2.workId, schema.workPartV2.position)
          .having(sql`count(*) > 1`)
          .limit(detailLimit)
      : Promise.resolve([]),
    includeDetailRows && unclassifiedUnlinkedTracks.value > 0
      ? db
          .selectDistinct({
            spotifyTrackId: schema.spotifyTrack.spotifyId,
            title: schema.spotifyTrack.title,
            queueStatus: schema.matchQueue.status,
          })
          .from(schema.spotifyTrack)
          .leftJoin(
            schema.trackWorkPartV2,
            eq(schema.trackWorkPartV2.spotifyTrackId, schema.spotifyTrack.spotifyId),
          )
          .leftJoin(
            schema.matchQueue,
            eq(schema.matchQueue.spotifyId, schema.spotifyTrack.spotifyId),
          )
          .where(
            and(
              isNull(schema.trackWorkPartV2.spotifyTrackId),
              or(isNull(schema.matchQueue.status), ne(schema.matchQueue.status, 'not_classical')),
            ),
          )
          .limit(detailLimit)
      : Promise.resolve([]),
    includeDetailRows && memberRecordingsWithoutPopularity.value > 0
      ? db
          .selectDistinct({
            recordingId: schema.recordingV2.id,
            workId: schema.recordingV2.workId,
            spotifyAlbumId: schema.recordingV2.spotifyAlbumId,
          })
          .from(schema.recordingV2)
          .innerJoin(
            schema.recordingTrackV2,
            eq(schema.recordingTrackV2.recordingId, schema.recordingV2.id),
          )
          .where(isNull(schema.recordingV2.popularity))
          .limit(detailLimit)
      : Promise.resolve([]),
  ]);

  const hardInvariants = {
    storedTracks: storedTracks.value,
    linkedTracks: linkedTracks.value,
    partLinks: partLinks.value,
    tracksWithoutRecording: tracksWithoutRecording.value,
    recordingTracksWithoutParts: recordingTracksWithoutParts.value,
    crossWorkLinks: crossWorkLinks.value,
    duplicateWorkPartPositions: duplicatePositions.value,
    unclassifiedUnlinkedTracks: unclassifiedUnlinkedTracks.value,
    memberRecordingsWithoutPopularity: memberRecordingsWithoutPopularity.value,
    duplicateCatalogWorks: duplicateCatalogGroups.length,
  };
  const reviewBacklog = {
    needsReviewLinks: needsReview.value,
    recordingsWithoutMembers: recordingsWithoutMembers.value,
    recordingsWithoutMappedTracks: recordingsWithoutMappedTracks.value,
    unnamedParts: unnamedParts.value,
    likelyDuplicatePartWorks: new Set(
      likelyDuplicatePartGroups.flatMap(([, ids]) =>
        allParts.filter((part) => ids.includes(part.id)).map((part) => part.workId),
      ),
    ).size,
    likelyRedundantPartRows: likelyDuplicatePartGroups.reduce(
      (sum, [, ids]) => sum + ids.length - 1,
      0,
    ),
    composersWithoutBirthYear: composersWithoutBirthYear.value,
    worksWithoutForm: worksWithoutForm.value,
    likelyDuplicateWorkGroups: likelyDuplicateWorkGroups.length,
    likelyRedundantWorkRows: likelyDuplicateWorkGroups.reduce(
      (sum, [, ids]) => sum + ids.length - 1,
      0,
    ),
  };

  const hardViolationDetails = {
    tracksWithoutRecording: tracksWithoutRecordingRows,
    recordingTracksWithoutParts: recordingTracksWithoutPartsRows,
    crossWorkLinks: crossWorkLinkRows,
    duplicateWorkPartPositions: duplicatePositionRows,
    unclassifiedUnlinkedTracks: unclassifiedUnlinkedTrackRows,
    memberRecordingsWithoutPopularity: memberRecordingWithoutPopularityRows,
    duplicateCatalogWorks: duplicateCatalogGroups.slice(0, detailLimit).map(([key, ids]) => ({
      composerId: Number(key.slice(0, key.indexOf(':'))),
      catalogIdentity: key.slice(key.indexOf(':') + 1),
      workIds: ids,
    })),
  };
  const reviewDetails = {
    recordingsWithoutMembers: emptyRecordingRows,
    unnamedParts: unnamedPartRows,
    composersWithoutBirthYear: missingComposerRows,
    worksWithoutForm: missingFormRows,
    likelyDuplicatePartGroups: likelyDuplicatePartGroups
      .slice(0, detailLimit)
      .map(([key, ids]) => ({
        workId: Number(key.slice(0, key.indexOf(':'))),
        normalizedIdentity: key.slice(key.indexOf(':') + 1),
        partIds: ids,
      })),
    likelyDuplicateWorkGroups: likelyDuplicateWorkGroups
      .slice(0, detailLimit)
      .map(([key, ids]) => ({
        composerId: Number(key.slice(0, key.indexOf(':'))),
        normalizedTitle: key.slice(key.indexOf(':') + 1),
        workIds: ids,
      })),
  };
  const details = { hardViolations: hardViolationDetails, ...reviewDetails };

  // MusicBrainz is a second source, not an authority: this section measures how
  // much of the library it reaches and where it disagrees with us. Disagreements
  // are reported, never resolved here — our parser is often the more specific of
  // the two, so a difference is a prompt to look, not a defect.
  const [mbCoverage] = await db
    .select({
      tracks: sql`(select count(*) from spotify_track)`.mapWith(Number),
      tracksWithIsrc: sql`(select count(isrc) from spotify_track)`.mapWith(Number),
      tracksWithRecording: sql`(select count(mb_recording_id) from spotify_track)`.mapWith(Number),
      works: sql`(select count(*) from work)`.mapWith(Number),
      worksLinked: sql`(select count(musicbrainz_id) from work)`.mapWith(Number),
      parts: sql`(select count(*) from work_part_v2)`.mapWith(Number),
      partsLinked: sql`(select count(musicbrainz_id) from work_part_v2)`.mapWith(Number),
      composers: sql`(select count(*) from composer)`.mapWith(Number),
      composersLinked: sql`(select count(musicbrainz_id) from composer)`.mapWith(Number),
      catalogueRows:
        sql`(select count(*) from work_catalog_v2 where source = 'musicbrainz')`.mapWith(Number),
      facts: sql`(select count(*) from musicbrainz_fact)`.mapWith(Number),
    })
    .from(sql`(select 1)`);

  const [mbConflicts] = await db
    .select({
      composerBirthYear: sql`(
        select count(*) from musicbrainz_fact f join composer c on c.id = f.entity_id
        where f.entity_type = 'composer' and f.field = 'birth_year'
          and c.birth_year is not null and cast(c.birth_year as text) <> f.value)`.mapWith(Number),
      composerDeathYear: sql`(
        select count(*) from musicbrainz_fact f join composer c on c.id = f.entity_id
        where f.entity_type = 'composer' and f.field = 'death_year'
          and c.death_year is not null and cast(c.death_year as text) <> f.value)`.mapWith(Number),
      workForm: sql`(
        select count(*) from musicbrainz_fact f join work w on w.id = f.entity_id
        where f.entity_type = 'work' and f.field = 'work_type'
          and w.form is not null and lower(w.form) <> lower(f.value))`.mapWith(Number),
      partTitle: sql`(
        select count(*) from musicbrainz_fact f join work_part_v2 p on p.id = f.entity_id
        where f.entity_type = 'work_part' and f.field = 'part_title'
          and p.title is not null and lower(p.title) <> lower(f.value))`.mapWith(Number),
    })
    .from(sql`(select 1)`);

  const [mbFillable] = await db
    .select({
      composerBirthYear: sql`(
        select count(*) from musicbrainz_fact f join composer c on c.id = f.entity_id
        where f.entity_type = 'composer' and f.field = 'birth_year' and c.birth_year is null)`.mapWith(
        Number,
      ),
      workForm: sql`(
        select count(*) from musicbrainz_fact f join work w on w.id = f.entity_id
        where f.entity_type = 'work' and f.field = 'work_type' and w.form is null)`.mapWith(Number),
    })
    .from(sql`(select 1)`);

  // Counting raw facts here would promise fills that promotion then refuses:
  // MusicBrainz often names the whole work where we expect a movement, and
  // those values are discarded rather than written. Applying the same
  // transformation keeps this honest about what running it would do.
  const { movementTitleFromMusicBrainz } = await import('@/lib/musicbrainz-promotion');
  const partTitleCandidates = await db
    .select({ label: schema.workPartV2.label, value: schema.musicbrainzFact.value })
    .from(schema.musicbrainzFact)
    .innerJoin(schema.workPartV2, eq(schema.workPartV2.id, schema.musicbrainzFact.entityId))
    .where(
      and(
        eq(schema.musicbrainzFact.entityType, 'work_part'),
        eq(schema.musicbrainzFact.field, 'part_title'),
        isNull(schema.workPartV2.title),
      ),
    );
  const partTitleFillable = partTitleCandidates.filter(
    (row) => movementTitleFromMusicBrainz(row.value, row.label) !== null,
  ).length;

  const failingMetrics = new Set([
    'tracksWithoutRecording',
    'recordingTracksWithoutParts',
    'crossWorkLinks',
    'duplicateWorkPartPositions',
    'unclassifiedUnlinkedTracks',
    'memberRecordingsWithoutPopularity',
    'duplicateCatalogWorks',
  ]);
  const hasHardFailures = [...failingMetrics].some(
    (metric) => hardInvariants[metric as keyof typeof hardInvariants] > 0,
  );

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          ok: !hasHardFailures,
          hardInvariants,
          reviewBacklog,
          musicbrainz: {
            coverage: mbCoverage,
            conflicts: mbConflicts,
            fillable: { ...mbFillable, partTitle: partTitleFillable },
          },
          closedByReview: Object.fromEntries(
            recordedReviews.map((row) => [row.decision, row.value]),
          ),
          ...(allDetails ? { details } : {}),
        },
        null,
        2,
      ),
    );
  } else {
    console.log('\nHard invariants');
    console.table(
      Object.entries(hardInvariants).map(([metric, value]) => ({
        metric,
        value,
        status: failingMetrics.has(metric) ? (value === 0 ? 'PASS' : 'FAIL') : 'INFO',
      })),
    );
    console.log('\nReview backlog (informational; never auto-fix)');
    console.table(
      Object.entries(reviewBacklog).map(([metric, value]) => ({ metric, count: value })),
    );
    if (mbCoverage.facts > 0 || mbCoverage.tracksWithIsrc > 0) {
      console.log('\nMusicBrainz (second source; informational)');
      console.table([
        {
          metric: 'tracks with an ISRC',
          value: `${mbCoverage.tracksWithIsrc} / ${mbCoverage.tracks}`,
        },
        {
          metric: 'tracks matched to a recording',
          value: `${mbCoverage.tracksWithRecording} / ${mbCoverage.tracks}`,
        },
        { metric: 'works linked', value: `${mbCoverage.worksLinked} / ${mbCoverage.works}` },
        { metric: 'parts linked', value: `${mbCoverage.partsLinked} / ${mbCoverage.parts}` },
        {
          metric: 'composers linked',
          value: `${mbCoverage.composersLinked} / ${mbCoverage.composers}`,
        },
        { metric: 'catalogue rows imported', value: String(mbCoverage.catalogueRows) },
        { metric: 'facts recorded', value: String(mbCoverage.facts) },
      ]);
      const fillable = mbFillable.composerBirthYear + mbFillable.workForm + partTitleFillable;
      const conflicting = Object.values(mbConflicts).reduce((a, b) => a + b, 0);
      if (fillable > 0 || conflicting > 0) {
        console.log(
          (fillable > 0
            ? `MusicBrainz can fill ${fillable} empty field(s) — run \`pnpm mb:promote\`.\n`
            : 'Nothing left for MusicBrainz to fill.\n') +
            `${conflicting} field(s) differ from what we hold; promotion never overwrites them.`,
        );
        console.table([
          {
            field: 'composer birth year',
            fillable: mbFillable.composerBirthYear,
            differs: mbConflicts.composerBirthYear,
          },
          { field: 'composer death year', fillable: '-', differs: mbConflicts.composerDeathYear },
          { field: 'work form', fillable: mbFillable.workForm, differs: mbConflicts.workForm },
          { field: 'part title', fillable: partTitleFillable, differs: mbConflicts.partTitle },
        ]);
      }
    }

    if (recordedReviews.length > 0) {
      console.log(
        '\nClosed by a recorded review decision — these rows still have the gap;' +
          '\nsomeone looked and wrote down why in metadata_migration_audit.',
      );
      console.table(recordedReviews.map((row) => ({ decision: row.decision, rows: row.value })));
    }

    const samples = allDetails ? 'Details' : 'Samples';
    for (const [name, rows] of Object.entries(hardViolationDetails)) {
      if (rows.length === 0) continue;
      console.log(`\n${samples}: hard violation — ${name}`);
      console.table(rows);
    }
    for (const [name, rows] of Object.entries(reviewDetails)) {
      if (rows.length === 0) continue;
      console.log(`\n${samples}: ${name}`);
      console.table(rows);
    }
    if (!allDetails) console.log('\nUse --details for complete affected-row lists; --json for CI.');
    console.log(
      hasHardFailures ? '\nMetadata validation FAILED.' : '\nMetadata validation passed.',
    );
  }

  if (hasHardFailures) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
