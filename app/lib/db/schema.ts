import { relations, sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/*
 * Better Auth
 */

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).default(false).notNull(),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_userId_idx').on(table.userId)],
);

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', {
      mode: 'timestamp_ms',
    }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', {
      mode: 'timestamp_ms',
    }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index('account_userId_idx').on(table.userId)],
);

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

/*
 * Classical Music Schema
 */

export const composer = sqliteTable('composer', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  birthYear: integer('birth_year'),
  deathYear: integer('death_year'),
  biography: text('biography'),
  spotifyArtistId: text('spotify_artist_id')
    .unique()
    .references(() => spotifyArtist.spotifyId),
  /** MusicBrainz artist MBID, when we have confidently matched this composer. */
  musicbrainzId: text('musicbrainz_id').unique(),
});

export const work = sqliteTable(
  'work',
  {
    id: integer('id').primaryKey(),
    composerId: integer('composer_id')
      .notNull()
      .references(() => composer.id),
    title: text('title').notNull(),
    nickname: text('nickname'), // "moonlight", "spring"
    catalogSystem: text('catalog_system'), // "BWV", "K", "Op" - nullable for works without catalog numbers
    catalogNumber: text('catalog_number'), // "1052", "27/2" - nullable for works without catalog numbers
    yearComposed: integer('year_composed'),
    form: text('form'), // "concerto", "sonata", "fugue"
    /** MusicBrainz work MBID of the *parent* work, when matched. */
    musicbrainzId: text('musicbrainz_id').unique(),
  },
  (table) => [
    index('work_composer_idx').on(table.composerId),
    // For works WITH catalog numbers: unique by composer + catalog
    uniqueIndex('work_composer_catalog_idx')
      .on(table.composerId, table.catalogSystem, table.catalogNumber)
      .where(sql`${table.catalogSystem} IS NOT NULL AND ${table.catalogNumber} IS NOT NULL`),
    // For works WITHOUT catalog numbers: unique by composer + title
    uniqueIndex('work_composer_title_idx')
      .on(table.composerId, table.title)
      .where(sql`${table.catalogSystem} IS NULL AND ${table.catalogNumber} IS NULL`),
  ],
);

export const movement = sqliteTable(
  'movement',
  {
    id: integer('id').primaryKey(),
    workId: integer('work_id')
      .notNull()
      .references(() => work.id),
    number: integer('number').notNull(),
    title: text('title'), // "Allegro", null
  },
  (table) => [
    index('movement_work_idx').on(table.workId),
    uniqueIndex('movement_work_number_idx').on(table.workId, table.number),
  ],
);

export const spotifyAlbum = sqliteTable(
  'spotify_album',
  {
    spotifyId: text('spotify_id').primaryKey(),
    title: text('title').notNull(),
    year: integer('year'),
    popularity: integer('popularity'),
    images: text('images', { mode: 'json' }).$type<
      { url: string; width: number; height: number }[]
    >(),
    /** The release barcode Spotify reports; the key MusicBrainz indexes releases by. */
    upc: text('upc'),
    /** The MusicBrainz release this album is, when one carries the same barcode. */
    mbReleaseId: text('mb_release_id'),
    /**
     * How many releases carry this barcode. Without the count, a null release
     * is two different problems wearing the same face: MusicBrainz has nothing
     * (add the release) or it has several and none of them identifies this
     * album (pick one). Telling someone to add a release that already exists
     * is how duplicates get created.
     */
    mbReleaseCandidates: integer('mb_release_candidates'),
    /**
     * When we last asked MusicBrainz about this barcode. Without it a null
     * release is ambiguous — it could mean MusicBrainz does not have the
     * release, or simply that nobody has looked yet, and those call for
     * completely different work.
     */
    mbCheckedAt: integer('mb_checked_at', { mode: 'timestamp_ms' }),
  },
  (table) => [index('spotify_album_mb_release_idx').on(table.mbReleaseId)],
);

export const recording = sqliteTable(
  'recording',
  {
    id: integer('id').primaryKey(),
    spotifyAlbumId: text('spotify_album_id')
      .notNull()
      .references(() => spotifyAlbum.spotifyId),
    workId: integer('work_id')
      .notNull()
      .references(() => work.id),
    popularity: integer('popularity'), // calculated by averaging tracks
  },
  (table) => [
    index('recording_work_idx').on(table.workId),
    index('recording_album_idx').on(table.spotifyAlbumId),
    uniqueIndex('recording_album_work_idx').on(table.spotifyAlbumId, table.workId),
  ],
);

export const spotifyTrack = sqliteTable(
  'spotify_track',
  {
    spotifyId: text('spotify_id').primaryKey(),
    title: text('title').notNull(),
    trackNumber: integer('track_number').notNull(),
    discNumber: integer('disc_number').default(1).notNull(),
    durationMs: integer('duration_ms').notNull(),
    popularity: integer('popularity'),
    spotifyAlbumId: text('spotify_album_id')
      .notNull()
      .references(() => spotifyAlbum.spotifyId),
    /**
     * The track's ISRC as Spotify reports it. Stored rather than re-fetched
     * because it is the join key into MusicBrainz, and re-deriving it for the
     * whole library costs a full pass over the Spotify API.
     */
    isrc: text('isrc'),
    /** MusicBrainz recording MBID this ISRC resolves to, when it resolves. */
    mbRecordingId: text('mb_recording_id'),
  },
  (table) => [
    index('spotify_track_isrc_idx').on(table.isrc),
    index('spotify_track_mb_recording_idx').on(table.mbRecordingId),
  ],
);

/**
 * Parallel v2 metadata tables. These intentionally coexist with movement,
 * track_movement, and recording until the migration has been validated.
 */
export const workCatalogV2 = sqliteTable(
  'work_catalog_v2',
  {
    id: integer('id').primaryKey(),
    workId: integer('work_id')
      .notNull()
      .references(() => work.id),
    system: text('system').notNull(),
    number: text('number').notNull(),
    normalizedSystem: text('normalized_system').notNull(),
    normalizedNumber: text('normalized_number').notNull(),
    isPrimary: integer('is_primary', { mode: 'boolean' }).default(false).notNull(),
    /**
     * Where this catalogue reference came from. MusicBrainz carries alternate
     * catalogues our parser never sees (Chopin's B./C., Scarlatti's Longo,
     * the revised Köchel), and a reader searching by one of those needs to
     * find the work. Keeping the source means a wrong import can be undone
     * without touching parser-derived rows.
     */
    source: text('source', { enum: ['parser', 'musicbrainz'] })
      .default('parser')
      .notNull(),
  },
  (table) => [
    index('work_catalog_v2_work_idx').on(table.workId),
    index('work_catalog_v2_lookup_idx').on(table.normalizedSystem, table.normalizedNumber),
    uniqueIndex('work_catalog_v2_work_catalog_idx').on(
      table.workId,
      table.normalizedSystem,
      table.normalizedNumber,
    ),
  ],
);

export const workPartV2 = sqliteTable(
  'work_part_v2',
  {
    id: integer('id').primaryKey(),
    workId: integer('work_id')
      .notNull()
      .references(() => work.id),
    position: integer('position').notNull(),
    label: text('label'),
    title: text('title'),
    /** MusicBrainz work MBID of the movement/leaf work, when matched. */
    musicbrainzId: text('musicbrainz_id'),
  },
  (table) => [
    index('work_part_v2_work_idx').on(table.workId),
    index('work_part_v2_musicbrainz_idx').on(table.musicbrainzId),
    uniqueIndex('work_part_v2_work_position_idx').on(table.workId, table.position),
  ],
);

export const recordingV2 = sqliteTable(
  'recording_v2',
  {
    id: integer('id').primaryKey(),
    spotifyAlbumId: text('spotify_album_id')
      .notNull()
      .references(() => spotifyAlbum.spotifyId),
    workId: integer('work_id')
      .notNull()
      .references(() => work.id),
    popularity: integer('popularity'),
  },
  (table) => [
    index('recording_v2_work_idx').on(table.workId),
    index('recording_v2_album_idx').on(table.spotifyAlbumId),
  ],
);

export const recordingTrackV2 = sqliteTable(
  'recording_track_v2',
  {
    recordingId: integer('recording_id')
      .notNull()
      .references(() => recordingV2.id),
    spotifyTrackId: text('spotify_track_id')
      .notNull()
      .references(() => spotifyTrack.spotifyId),
  },
  (table) => [
    primaryKey({ columns: [table.recordingId, table.spotifyTrackId] }),
    uniqueIndex('recording_track_v2_track_idx').on(table.spotifyTrackId),
  ],
);

export const trackWorkPartV2 = sqliteTable(
  'track_work_part_v2',
  {
    spotifyTrackId: text('spotify_track_id')
      .notNull()
      .references(() => spotifyTrack.spotifyId),
    workPartId: integer('work_part_id')
      .notNull()
      .references(() => workPartV2.id),
    startMs: integer('start_ms'),
    endMs: integer('end_ms'),
    matchSource: text('match_source', {
      enum: ['parser', 'migrated', 'manual', 'musicbrainz'],
    })
      .default('migrated')
      .notNull(),
    matchStatus: text('match_status', { enum: ['confirmed', 'needs_review'] })
      .default('needs_review')
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.spotifyTrackId, table.workPartId] }),
    index('track_work_part_v2_part_idx').on(table.workPartId),
    index('track_work_part_v2_status_idx').on(table.matchStatus),
  ],
);

/**
 * What MusicBrainz asserts about entities we have already matched to it.
 *
 * Kept apart from the columns the app reads so that importing MusicBrainz
 * never silently overwrites something we already know. A value here is a
 * second opinion: where our own column is empty it is a gap we can close,
 * and where the two differ it is a disagreement a person should look at.
 * Folding the two together would destroy exactly that distinction.
 *
 * Decisions about a fact — accepted, rejected, "reviewed, they disagree and
 * ours is right" — belong in `metadata_migration_audit` like every other
 * metadata decision, not here. This table only records what MusicBrainz said.
 */
export const musicbrainzFact = sqliteTable(
  'musicbrainz_fact',
  {
    id: integer('id').primaryKey(),
    entityType: text('entity_type', { enum: ['composer', 'work', 'work_part'] }).notNull(),
    entityId: integer('entity_id').notNull(),
    /** 'birth_year' | 'death_year' | 'work_type' | 'part_title' */
    field: text('field').notNull(),
    value: text('value').notNull(),
    /** The MusicBrainz entity the fact was read from. */
    musicbrainzId: text('musicbrainz_id').notNull(),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('musicbrainz_fact_entity_field_idx').on(
      table.entityType,
      table.entityId,
      table.field,
    ),
    index('musicbrainz_fact_field_idx').on(table.field),
  ],
);

export const metadataMigrationAudit = sqliteTable(
  'metadata_migration_audit',
  {
    id: integer('id').primaryKey(),
    entityType: text('entity_type').notNull(),
    sourceId: text('source_id').notNull(),
    targetId: text('target_id'),
    decision: text('decision').notNull(),
    reason: text('reason'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('metadata_migration_audit_entity_source_idx').on(table.entityType, table.sourceId),
    index('metadata_migration_audit_decision_idx').on(table.decision),
  ],
);

export const spotifyArtist = sqliteTable('spotify_artist', {
  spotifyId: text('spotify_id').primaryKey(),
  name: text('name').notNull(),
  popularity: integer('popularity'),
  images: text('images', { mode: 'json' }).$type<
    { url: string; width: number; height: number }[]
  >(),
});

export const trackArtists = sqliteTable(
  'track_artists',
  {
    spotifyTrackId: text('spotify_track_id')
      .notNull()
      .references(() => spotifyTrack.spotifyId),
    spotifyArtistId: text('spotify_artist_id')
      .notNull()
      .references(() => spotifyArtist.spotifyId),
  },
  (table) => [primaryKey({ columns: [table.spotifyTrackId, table.spotifyArtistId] })],
);

export const trackMovement = sqliteTable(
  'track_movement',
  {
    spotifyTrackId: text('spotify_track_id')
      .notNull()
      .references(() => spotifyTrack.spotifyId),
    movementId: integer('movement_id')
      .notNull()
      .references(() => movement.id),
    startMs: integer('start_ms'),
    endMs: integer('end_ms'),
  },
  (table) => [primaryKey({ columns: [table.spotifyTrackId, table.movementId] })],
);

export const matchQueue = sqliteTable(
  'match_queue',
  {
    spotifyId: text('spotify_id').primaryKey(),
    spotifyAlbumId: text('spotify_album_id'),
    submittedAt: integer('submitted_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    submittedBy: text('submitted_by').notNull(),
    status: text('status').notNull(), // "pending", "processing", "matched", "failed", "not_classical"
    attempts: integer('attempts').default(0).notNull(),
    lastAttemptAt: integer('last_attempt_at', { mode: 'timestamp_ms' }),
    processedAt: integer('processed_at', { mode: 'timestamp_ms' }),
    errorMessage: text('error_message'),
    claimOwnerId: text('workflow_run_id'), // Legacy physical column name; now used as a claim lease.
  },
  (table) => [
    index('match_queue_status_idx').on(table.status),
    index('match_queue_album_idx').on(table.spotifyAlbumId),
    index('match_queue_status_album_idx').on(table.status, table.spotifyAlbumId),
  ],
);

/*
 * Classical Music Relations
 */

export const composerRelations = relations(composer, ({ one, many }) => ({
  works: many(work),
  spotifyArtist: one(spotifyArtist, {
    fields: [composer.spotifyArtistId],
    references: [spotifyArtist.spotifyId],
  }),
}));

export const workRelations = relations(work, ({ one, many }) => ({
  composer: one(composer, {
    fields: [work.composerId],
    references: [composer.id],
  }),
  movements: many(movement),
  recordings: many(recording),
}));

export const movementRelations = relations(movement, ({ one, many }) => ({
  work: one(work, {
    fields: [movement.workId],
    references: [work.id],
  }),
  trackMovements: many(trackMovement),
}));

export const spotifyAlbumRelations = relations(spotifyAlbum, ({ many }) => ({
  recordings: many(recording),
}));

export const recordingRelations = relations(recording, ({ one, many }) => ({
  spotifyAlbum: one(spotifyAlbum, {
    fields: [recording.spotifyAlbumId],
    references: [spotifyAlbum.spotifyId],
  }),
  work: one(work, {
    fields: [recording.workId],
    references: [work.id],
  }),
  tracks: many(spotifyTrack),
}));

export const spotifyTrackRelations = relations(spotifyTrack, ({ one, many }) => ({
  album: one(spotifyAlbum, {
    fields: [spotifyTrack.spotifyAlbumId],
    references: [spotifyAlbum.spotifyId],
  }),
  trackArtists: many(trackArtists),
  trackMovements: many(trackMovement),
}));

export const spotifyArtistRelations = relations(spotifyArtist, ({ one, many }) => ({
  trackArtists: many(trackArtists),
  composer: one(composer, {
    fields: [spotifyArtist.spotifyId],
    references: [composer.spotifyArtistId],
  }),
}));

export const trackArtistsRelations = relations(trackArtists, ({ one }) => ({
  track: one(spotifyTrack, {
    fields: [trackArtists.spotifyTrackId],
    references: [spotifyTrack.spotifyId],
  }),
  artist: one(spotifyArtist, {
    fields: [trackArtists.spotifyArtistId],
    references: [spotifyArtist.spotifyId],
  }),
}));

export const trackMovementRelations = relations(trackMovement, ({ one }) => ({
  track: one(spotifyTrack, {
    fields: [trackMovement.spotifyTrackId],
    references: [spotifyTrack.spotifyId],
  }),
  movement: one(movement, {
    fields: [trackMovement.movementId],
    references: [movement.id],
  }),
}));
