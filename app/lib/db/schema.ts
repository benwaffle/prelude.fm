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
    /**
     * The musical form, as MusicBrainz states it.
     *
     * Empty where MusicBrainz has no type for the work. That is a gap rather
     * than a failure: the parser's guess is kept in `parser_form` and is not
     * shown, because it was inferred from a Spotify track title and nobody
     * has checked it.
     */
    form: text('form'),
    /**
     * What the parser guessed the form was, before MusicBrainz was consulted.
     *
     * Kept rather than discarded because it is useful for things that do not
     * need to be right — recommendation, grouping, categorisation — and it is
     * more specific than MusicBrainz's fixed vocabulary: "violin concerto"
     * where MusicBrainz says "concerto". It is simply not evidence, so it
     * does not sit in the column the reader displays.
     */
    parserForm: text('parser_form'),
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
  },
  (table) => [index('spotify_track_isrc_idx').on(table.isrc)],
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
    /** What the parser called this movement, where MusicBrainz replaced it. */
    parserTitle: text('parser_title'),
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

/*
 * MusicBrainz gateway: request budget and kill switch
 */

/**
 * Requests spent against the MusicBrainz web service, per UTC day and channel.
 *
 * Persisted rather than counted in memory because serverless instances come
 * and go, so a per-process tally measures one lambda instead of the service.
 * It is also the number that decides when the web service stops being enough
 * and a local mirror becomes necessary, which makes it worth keeping even
 * when no cap is close.
 */
export const mbRequestBudget = sqliteTable(
  'mb_request_budget',
  {
    /** UTC date, `YYYY-MM-DD`. */
    day: text('day').notNull(),
    /** 'interactive' | 'backfill' | 'bot' */
    channel: text('channel').notNull(),
    requests: integer('requests').default(0).notNull(),
  },
  (table) => [primaryKey({ columns: [table.day, table.channel] })],
);

/**
 * The next moment a MusicBrainz request may be sent.
 *
 * One row, shared by every process. The in-process scheduler can only space
 * out its own requests, and there is never only one process: a serverless
 * deployment runs several instances, and a backfill on somebody's laptop runs
 * beside them. Each of them spacing its own requests a second apart still
 * adds up to more than one request per second at the far end.
 *
 * So a slot is claimed here first. The claim is a single atomic update that
 * moves the marker forward by one interval and returns the moment it moved
 * from, which is that caller's turn; the caller then waits for it. Two
 * processes asking at once get consecutive slots rather than the same one.
 * Times are the database's own clock, so the processes do not need to agree
 * on what time it is.
 */
export const mbRateSlot = sqliteTable('mb_rate_slot', {
  id: integer('id').primaryKey(),
  nextSlotAt: integer('next_slot_at').notNull(),
});

/**
 * Per-channel pause flags and cap overrides.
 *
 * A row for the pseudo-channel `all` applies to every channel. This exists so
 * that stopping traffic to somebody else's server, or widening the bot's daily
 * cap once its submissions have been reconciled, does not require a deploy.
 */
export const mbGatewayControl = sqliteTable('mb_gateway_control', {
  /** 'all' | 'interactive' | 'backfill' | 'bot' */
  channel: text('channel').primaryKey(),
  paused: integer('paused', { mode: 'boolean' }).default(false).notNull(),
  /** Null means the built-in default for that channel. */
  dailyCap: integer('daily_cap'),
  note: text('note'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
});

/*
 * The MusicBrainz cache
 *
 * MusicBrainz entities as MusicBrainz states them, keyed by MBID and shared by
 * every user. These tables are a cache of somebody else's database, not our
 * interpretation of it: nothing here is edited by hand, and anything we
 * believe that MusicBrainz does not is recorded elsewhere.
 *
 * There is deliberately no `mb_fetch_log`. Freshness is the `fetched_at` on
 * each row, "have we read this work properly or only seen it named" is
 * `mb_work.detail`, and request accounting is `mb_request_budget`. A separate
 * log would restate all three and could disagree with them.
 */

export const mbArtist = sqliteTable('mb_artist', {
  mbid: text('mbid').primaryKey(),
  name: text('name').notNull(),
  /**
   * The name a release printed for this artist.
   *
   * MusicBrainz files an artist under their own script, so a Japanese
   * conductor is 鈴木雅明 and a Russian violinist is Дмитрий Синьковский. The
   * release's artist credit carries the Latin form the label printed, which
   * is what the rest of this interface is written in, and it arrives with the
   * release read rather than costing a request of its own.
   */
  creditedName: text('credited_name'),
  sortName: text('sort_name'),
  /** 'Person' | 'Group' | 'Orchestra' | 'Choir' | ... */
  type: text('type'),
  beginYear: integer('begin_year'),
  endYear: integer('end_year'),
  fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
});

/**
 * A MusicBrainz work, and the parent it is a part of.
 *
 * The parent link is the whole point of this table. Our own model is flat —
 * a work owns a list of leaf parts — and that flatness is what produced
 * eighteen separate works called "The Well-Tempered Clavier, Book 2", because
 * there was nowhere to say which prelude each one was. MusicBrainz's tree is
 * recursive and arbitrarily deep, so we store it as it is and decide which
 * level to show when reading.
 *
 * `detail` distinguishes a work we have actually fetched from one we only know
 * the name of because a recording pointed at it. A release fetch names dozens
 * of works and gives their parents for none of them, so without this the cache
 * could not tell "no parent" from "not looked yet".
 */
export const mbWork = sqliteTable(
  'mb_work',
  {
    mbid: text('mbid').primaryKey(),
    title: text('title').notNull(),
    /** MusicBrainz work type: 'Sonata', 'Symphony', 'Aria', ... */
    type: text('type'),
    parentMbid: text('parent_mbid'),
    /** This work's position among its parent's parts, from the relation's ordering-key. */
    orderingKey: integer('ordering_key'),
    composerMbid: text('composer_mbid'),
    /** 'stub': named by a recording. 'full': fetched with its relations. */
    detail: text('detail', { enum: ['stub', 'full'] })
      .default('stub')
      .notNull(),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index('mb_work_parent_idx').on(table.parentMbid),
    index('mb_work_composer_idx').on(table.composerMbid),
    index('mb_work_detail_idx').on(table.detail),
  ],
);

/**
 * Catalogue references — BWV, Köchel, Ryom, Longo — from a work's Catalogue
 * series relationships.
 *
 * Normalised with our own `classical-normalization`, which is better at this
 * than MusicBrainz's series-name-plus-free-text: the number arrives as an
 * attribute string like "BWV 1067" and has to be parsed back out either way.
 */
export const mbWorkCatalogue = sqliteTable(
  'mb_work_catalogue',
  {
    workMbid: text('work_mbid').notNull(),
    seriesMbid: text('series_mbid').notNull(),
    system: text('system').notNull(),
    number: text('number').notNull(),
    normalizedSystem: text('normalized_system').notNull(),
    normalizedNumber: text('normalized_number').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workMbid, table.seriesMbid, table.number] }),
    index('mb_work_catalogue_lookup_idx').on(table.normalizedSystem, table.normalizedNumber),
  ],
);

/**
 * A recording: one performance, independent of the releases carrying it.
 *
 * Our current model ties a recording to a Spotify album, so the same
 * performance issued twice becomes two recordings of two works. MusicBrainz
 * has it the right way round and this table follows.
 */
export const mbRecording = sqliteTable('mb_recording', {
  mbid: text('mbid').primaryKey(),
  title: text('title').notNull(),
  /** Milliseconds, as MusicBrainz reports it. */
  length: integer('length'),
  /**
   * 'stub': an ISRC search named this recording and nothing else is known.
   * 'full': read with its works and credits, from a release or its own lookup.
   *
   * An ISRC resolves without reference to a release, which is the only way to
   * anchor a track whose album MusicBrainz does not have. That leaves a
   * recording we can name but know nothing about, and this column is what
   * keeps that from looking like a broken reference: the stubs are the queue.
   */
  detail: text('detail', { enum: ['stub', 'full'] })
    .default('full')
    .notNull(),
  fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
});

/**
 * The ISRCs a recording carries.
 *
 * Stored because this is the join that anchors a Spotify track to a
 * MusicBrainz recording, and it has to be a local lookup rather than a search
 * request: Spotify gives us the ISRC, and everything downstream depends on
 * turning that into a recording without spending budget.
 *
 * Not keyed on the ISRC alone. An ISRC should identify one recording, but
 * MusicBrainz genuinely holds cases where a label attached the same one to
 * two — that is how Haydn's Symphony 87 lost its link — and a unique key here
 * would hide the conflict instead of letting us find and report it.
 */
export const mbRecordingIsrc = sqliteTable(
  'mb_recording_isrc',
  {
    isrc: text('isrc').notNull(),
    recordingMbid: text('recording_mbid').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.isrc, table.recordingMbid] }),
    index('mb_recording_isrc_recording_idx').on(table.recordingMbid),
  ],
);

/** The works a recording performs. Usually one; a medley has several. */
export const mbRecordingWork = sqliteTable(
  'mb_recording_work',
  {
    recordingMbid: text('recording_mbid').notNull(),
    workMbid: text('work_mbid').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.recordingMbid, table.workMbid] }),
    index('mb_recording_work_work_idx').on(table.workMbid),
  ],
);

/**
 * Who played, and what they did.
 *
 * This replaces counting artist name strings and calling the second most
 * frequent one the performer — a heuristic that cannot tell a conductor from
 * an orchestra and silently merges two artists who share a name. `role` is the
 * MusicBrainz relationship type; `instrument` qualifies it, so a violinist is
 * `instrument` + `violin` rather than a role of their own.
 */
export const mbRecordingCredit = sqliteTable(
  'mb_recording_credit',
  {
    recordingMbid: text('recording_mbid').notNull(),
    artistMbid: text('artist_mbid').notNull(),
    role: text('role').notNull(),
    /**
     * The instrument, or '' for a role that has none.
     *
     * Empty rather than null because this column is part of the key, and
     * SQLite allows duplicate rows when a key column is null — two identical
     * conductor credits would both be stored. Readers map '' back to absent.
     */
    instrument: text('instrument').default('').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.recordingMbid, table.artistMbid, table.role, table.instrument],
    }),
    index('mb_recording_credit_artist_idx').on(table.artistMbid),
  ],
);

export const mbRelease = sqliteTable(
  'mb_release',
  {
    mbid: text('mbid').primaryKey(),
    title: text('title').notNull(),
    barcode: text('barcode'),
    /** MusicBrainz release date, as given: 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD'. */
    date: text('date'),
    country: text('country'),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index('mb_release_barcode_idx').on(table.barcode)],
);

/**
 * A release's tracklist.
 *
 * This is what replaces the parser's album-local `recordingGroup` string and
 * the 0.55 Jaccard overlap used to reconcile it: an exact tracklist, stated by
 * MusicBrainz, in order.
 */
export const mbReleaseTrack = sqliteTable(
  'mb_release_track',
  {
    releaseMbid: text('release_mbid').notNull(),
    /** Disc, one-based. */
    medium: integer('medium').notNull(),
    /** Position within the disc, one-based. */
    position: integer('position').notNull(),
    recordingMbid: text('recording_mbid').notNull(),
    /** The title as printed on this release, which can differ from the recording's. */
    title: text('title').notNull(),
    length: integer('length'),
  },
  (table) => [
    primaryKey({ columns: [table.releaseMbid, table.medium, table.position] }),
    index('mb_release_track_recording_idx').on(table.recordingMbid),
  ],
);

/**
 * How a Spotify track was anchored to a MusicBrainz recording.
 *
 * `matched_by` is kept because the two routes do not deserve equal trust. An
 * ISRC is the label's own identifier and is nearly always right; a position on
 * a release is only as right as the release match behind it. Recording which
 * one was used means a later doubt can be narrowed to the rows that earned it,
 * rather than discarding everything.
 */
export const trackRecording = sqliteTable(
  'track_recording',
  {
    spotifyTrackId: text('spotify_track_id')
      .primaryKey()
      .references(() => spotifyTrack.spotifyId),
    recordingMbid: text('recording_mbid').notNull(),
    /** The ISRC that resolved it, when that is how it was resolved. */
    isrc: text('isrc'),
    matchedBy: text('matched_by', {
      enum: ['isrc', 'release_position'],
    }).notNull(),
    matchedAt: integer('matched_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index('track_recording_recording_idx').on(table.recordingMbid),
    index('track_recording_matched_by_idx').on(table.matchedBy),
  ],
);

/*
 * Contributions back to MusicBrainz
 */

/**
 * Every edit we have sent to MusicBrainz, whoever sent it.
 *
 * A human clicking through a prefilled form and a bot posting the same edit
 * are recorded identically, on purpose. Automation is something each class of
 * edit earns rather than a different pipeline: when the last step changes
 * from a click to a POST, nothing downstream of this table changes with it.
 *
 * It is also the cross-user deduplicator. Two people owning the same album
 * must not both submit its ISRCs, and once prelude has more than one user
 * nothing else knows that the first submission happened.
 *
 * `outcome` stays `pending` until somebody confirms the edit landed, because
 * a submitted edit is a proposal: MusicBrainz editors vote, and some of ours
 * will be voted down. Recording a submission as a success at the moment we
 * make it would be recording our intention rather than the result.
 */
export const mbSubmission = sqliteTable(
  'mb_submission',
  {
    id: integer('id').primaryKey(),
    /**
     * What kind of edit. 'isrc' and 'barcode' are mechanical and will one day
     * be the bot's; 'release', 'work' and 'work_relationship' stay human
     * because a wrong one of those is expensive for other people to undo.
     */
    kind: text('kind', {
      enum: ['isrc', 'barcode', 'streaming_url', 'release', 'work', 'work_relationship', 'error'],
    }).notNull(),
    /** The MusicBrainz entity being edited, or null when it does not exist yet. */
    targetMbid: text('target_mbid'),
    /** Our side of it: the Spotify track or album the evidence comes from. */
    subject: text('subject').notNull(),
    /** The value submitted — an ISRC, a barcode, a URL — for reconciliation. */
    value: text('value'),
    /** What convinced us, kept so a rejected edit can be understood later. */
    evidence: text('evidence', { mode: 'json' }).$type<Record<string, unknown>>(),
    /** 'human:<name>' or 'bot:prelude_fm_bot'. */
    submittedBy: text('submitted_by').notNull(),
    submittedAt: integer('submitted_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    /** The MusicBrainz edit number, once known. */
    editId: text('edit_id'),
    outcome: text('outcome', { enum: ['pending', 'applied', 'rejected', 'withdrawn'] })
      .default('pending')
      .notNull(),
    outcomeAt: integer('outcome_at', { mode: 'timestamp_ms' }),
    note: text('note'),
  },
  (table) => [
    // One submission per value per target: the deduplicator.
    uniqueIndex('mb_submission_identity_idx').on(table.kind, table.targetMbid, table.value),
    index('mb_submission_outcome_idx').on(table.outcome),
    index('mb_submission_subject_idx').on(table.subject),
  ],
);

/**
 * The latest result of each MusicBrainz cache invariant.
 *
 * One row per check, overwritten each time it runs. A history would answer
 * "when did this start" but the honest answer to that is in the git log and
 * the ingest logs; what a person needs here is whether the cache is sound
 * right now, on a page rather than behind a command.
 */
export const mbInvariantResult = sqliteTable('mb_invariant_result', {
  name: text('name').primaryKey(),
  severity: text('severity', { enum: ['hard', 'upstream', 'review'] }).notNull(),
  violations: integer('violations').notNull(),
  /** A few offending ids, so the report says what to look at. */
  samples: text('samples', { mode: 'json' }).$type<{ id: string; detail: string | null }[]>(),
  checkedAt: integer('checked_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
});
