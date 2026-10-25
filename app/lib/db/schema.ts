import { relations, sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { ReleasePrecheck } from '../release-precheck';
import type { ReleaseCorrectionRecord } from '../release-corrections';
import type { SeedPlan } from '../release-seeding';
import type { WorkProposal } from '../work-proposals';
import type { TrackWorkMatch } from '../track-work-links';

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
    /**
     * How many tracks Spotify says the album has. Null until the album is read again: albums
     * cached before this was stored can't show whether they are missing tracks.
     */
    spotifyTrackTotal: integer('spotify_track_total'),
    mbReleaseId: text('mb_release_id'),
    // What identified `mbReleaseId`: MusicBrainz's own link to this Spotify album, the barcode,
    // title and durations, or a person's pick. Null: matched before this was recorded, or not
    // matched.
    mbReleaseMatchedBy: text('mb_release_matched_by', {
      enum: ['spotify_link', 'barcode', 'title_duration', 'picked'],
    }),
    // Releases carrying this barcode: tells "MusicBrainz has none" from "several, none identifying
    // this album".
    mbReleaseCandidates: integer('mb_release_candidates'),
    /** Null: nobody has asked MusicBrainz about this barcode yet. */
    mbCheckedAt: integer('mb_checked_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('spotify_album_mb_release_idx').on(table.mbReleaseId),
    // The Matches tab finds an album by barcode (`ltrim` would read every album).
    index('spotify_album_upc_idx').on(table.upc),
    // The worker's recheck reads only the albums still missing a total; without this it reads all.
    index('spotify_album_unread_total_idx')
      .on(table.spotifyId)
      .where(sql`${table.spotifyTrackTotal} is null`),
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
    /** Stored because it is the join key into MusicBrainz. */
    isrc: text('isrc'),
  },
  (table) => [
    index('spotify_track_isrc_idx').on(table.isrc),
    // An album's tracks: every pass, the library's album mates, the admin views.
    index('spotify_track_album_idx').on(table.spotifyAlbumId),
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

export const matchQueue = sqliteTable(
  'match_queue',
  {
    spotifyId: text('spotify_id').primaryKey(),
    spotifyAlbumId: text('spotify_album_id'),
    submittedAt: integer('submitted_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    submittedBy: text('submitted_by').notNull(),
    /** See `MatchQueueStatus`. */
    status: text('status', {
      enum: ['pending', 'processing', 'matched', 'failed', 'not_classical', 'unresolved'],
    }).notNull(),
    attempts: integer('attempts').default(0).notNull(),
    lastAttemptAt: integer('last_attempt_at', { mode: 'timestamp_ms' }),
    processedAt: integer('processed_at', { mode: 'timestamp_ms' }),
    errorMessage: text('error_message'),
    claimOwnerId: text('workflow_run_id'), // Legacy column name; holds the claim lease.
    /** Null until the MB pass reports one. */
    pipelineOutcome: text('pipeline_outcome', {
      enum: ['ready', 'unanchored', 'unclassified', 'not_classical'],
    }),
    pipelineReason: text('pipeline_reason'),
    pipelineCompletedAt: integer('pipeline_completed_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('match_queue_status_idx').on(table.status),
    index('match_queue_album_idx').on(table.spotifyAlbumId),
    index('match_queue_status_album_idx').on(table.status, table.spotifyAlbumId),
    index('match_queue_pipeline_outcome_idx').on(table.pipelineOutcome),
  ],
);

// What the bulk crawl asked Spotify, so a rerun doesn't ask again. "Spotify has no such album" and
// "no Spotify track carries these ISRCs" are results, kept as `not_found`.
export const spotifyCrawl = sqliteTable(
  'spotify_crawl',
  {
    /** `mb_link`: a Spotify album MusicBrainz links to. `isrc_search`: a release searched by ISRC. */
    kind: text('kind', { enum: ['mb_link', 'isrc_search'] }).notNull(),
    /** The Spotify album ID (`mb_link`) or the MusicBrainz release MBID (`isrc_search`). */
    subject: text('subject').notNull(),
    /** The ISRCs searched for, in order; null for `mb_link`. */
    isrcs: text('isrcs', { mode: 'json' }).$type<string[]>(),
    /** The Spotify albums found. */
    albumIds: text('album_ids', { mode: 'json' }).$type<string[]>().notNull(),
    // `queued`: read and queued. `found`: the search named albums, queued unless already held.
    // `held`: a track we hold already carries the ISRC, so nothing was searched.
    outcome: text('outcome', { enum: ['queued', 'found', 'held', 'not_found'] }).notNull(),
    /** Spotify requests this row cost. */
    requests: integer('requests').notNull(),
    checkedAt: integer('checked_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.subject] }),
    index('spotify_crawl_outcome_idx').on(table.kind, table.outcome),
  ],
);

/** Global, no user relation. Precedence enforced in code: manual > musicbrainz > llm_proposal. */
export const trackClassification = sqliteTable(
  'track_classification',
  {
    spotifyTrackId: text('spotify_track_id')
      .primaryKey()
      .references(() => spotifyTrack.spotifyId),
    state: text('state', {
      enum: ['unreviewed', 'classical', 'not_classical', 'uncertain'],
    }).notNull(),
    provenance: text('provenance', {
      enum: ['musicbrainz', 'manual', 'llm_proposal'],
    }).notNull(),
    reason: text('reason'),
    /** Work or recording MBID the decision rests on, when known. */
    evidenceMbid: text('evidence_mbid'),
    decidedAt: integer('decided_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('track_classification_state_idx').on(table.state)],
);

export const spotifyTrackRelations = relations(spotifyTrack, ({ one, many }) => ({
  album: one(spotifyAlbum, {
    fields: [spotifyTrack.spotifyAlbumId],
    references: [spotifyAlbum.spotifyId],
  }),
  trackArtists: many(trackArtists),
}));

export const spotifyArtistRelations = relations(spotifyArtist, ({ many }) => ({
  trackArtists: many(trackArtists),
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

/** Persisted because serverless instances come and go. */
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

// One row shared by every process: a claim atomically moves the marker one interval forward on the
// DB clock.
export const mbRateSlot = sqliteTable('mb_rate_slot', {
  id: integer('id').primaryKey(),
  nextSlotAt: integer('next_slot_at').notNull(),
});

/** A row for the pseudo-channel `all` applies to every channel. */
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

// A cache of MusicBrainz as it states it, keyed by MBID; nothing here is edited by hand.

export const mbArtist = sqliteTable('mb_artist', {
  mbid: text('mbid').primaryKey(),
  name: text('name').notNull(),
  // The Latin-script name the release credit printed (MusicBrainz files 鈴木雅明 under his own script).
  creditedName: text('credited_name'),
  sortName: text('sort_name'),
  /** 'Person' | 'Group' | 'Orchestra' | 'Choir' | ... */
  type: text('type'),
  beginYear: integer('begin_year'),
  endYear: integer('end_year'),
  // Null with `linksReadAt` set means MusicBrainz has no link; null without it means we have not
  // looked.
  spotifyArtistId: text('spotify_artist_id'),
  linksReadAt: integer('links_read_at', { mode: 'timestamp_ms' }),
  fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
});

// `detail` tells a fetched work from one only named by a recording, so "no parent" differs from
// "not looked yet".
export const mbWork = sqliteTable(
  'mb_work',
  {
    mbid: text('mbid').primaryKey(),
    title: text('title').notNull(),
    /** MusicBrainz work type: 'Sonata', 'Symphony', 'Aria', ... */
    type: text('type'),
    parentMbid: text('parent_mbid'),
    /** Position among the parent's parts, from the relation's ordering-key. */
    orderingKey: integer('ordering_key'),
    composerMbid: text('composer_mbid'),
    /** The work's IMSLP page, from its MusicBrainz URL links; null when MusicBrainz lists none. */
    imslpUrl: text('imslp_url'),
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

// A work we know of that MusicBrainz lacks: ours, never written into `mb_work`. Its id is
// `pfm-<uuid>`, and `parent_id` names either kind of work. Readers take both kinds through
// `app/lib/db/work-tree-sql.ts`. Once MusicBrainz has it, `mb_work_mbid` says which work it is and
// readers skip it; whoever sets that re-points its parts and links to the MusicBrainz work.
export const ownWork = sqliteTable(
  'own_work',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    type: text('type'),
    parentId: text('parent_id'),
    orderingKey: integer('ordering_key'),
    composerMbid: text('composer_mbid'),
    /** Where we learned of it. */
    source: text('source', { enum: ['prelude', 'imslp', 'apple'] }).notNull(),
    mbWorkMbid: text('mb_work_mbid').unique(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index('own_work_parent_idx').on(table.parentId),
    index('own_work_composer_idx').on(table.composerMbid),
  ],
);

export const ownWorkCatalogue = sqliteTable(
  'own_work_catalogue',
  {
    workId: text('work_id')
      .notNull()
      .references(() => ownWork.id),
    system: text('system').notNull(),
    number: text('number').notNull(),
    normalizedSystem: text('normalized_system').notNull(),
    normalizedNumber: text('normalized_number').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workId, table.system, table.number] }),
    index('own_work_catalogue_lookup_idx').on(table.normalizedSystem, table.normalizedNumber),
  ],
);

export const mbRecording = sqliteTable('mb_recording', {
  mbid: text('mbid').primaryKey(),
  title: text('title').notNull(),
  /** Milliseconds. */
  length: integer('length'),
  // 'stub': named by an ISRC search only. 'full': read with its works and credits. The stubs are
  // the queue.
  detail: text('detail', { enum: ['stub', 'full'] })
    .default('full')
    .notNull(),
  fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
});

// Not unique on ISRC: MusicBrainz has ISRCs on several recordings, and a unique key would hide the
// conflict.
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

/** Usually one; a medley has several. */
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

// `role` is the relationship type; `instrument` qualifies it (violinist = `instrument` + `violin`).
export const mbRecordingCredit = sqliteTable(
  'mb_recording_credit',
  {
    recordingMbid: text('recording_mbid').notNull(),
    artistMbid: text('artist_mbid').notNull(),
    role: text('role').notNull(),
    // '' rather than null: it is part of the key, and SQLite allows duplicate rows when a key
    // column is null.
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
    /** 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD'. */
    date: text('date'),
    country: text('country'),
    // Null means the release predates `url-rels` ingestion, so an empty `mb_release_url` is
    // unknown, not absence.
    urlRelationsFetchedAt: integer('url_relations_fetched_at', { mode: 'timestamp_ms' }),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index('mb_release_barcode_idx').on(table.barcode)],
);

export const mbReleaseUrl = sqliteTable(
  'mb_release_url',
  {
    releaseMbid: text('release_mbid')
      .notNull()
      .references(() => mbRelease.mbid, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    relationshipType: text('relationship_type').notNull(),
    relationshipTypeId: text('relationship_type_id').notNull(),
    ended: integer('ended', { mode: 'boolean' }).default(false).notNull(),
    begin: text('begin'),
    end: text('end'),
    attributes: text('attributes', { mode: 'json' }).$type<string[]>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.releaseMbid, table.url, table.relationshipTypeId] }),
    index('mb_release_url_type_idx').on(table.relationshipTypeId),
    // Which release links this Spotify album, and the crawl's walk over every Spotify album link.
    index('mb_release_url_url_idx').on(table.url),
  ],
);

export const mbReleaseTrack = sqliteTable(
  'mb_release_track',
  {
    releaseMbid: text('release_mbid').notNull(),
    /** One-based. */
    medium: integer('medium').notNull(),
    /** One-based. */
    position: integer('position').notNull(),
    recordingMbid: text('recording_mbid').notNull(),
    /** As printed on this release, which can differ from the recording's. */
    title: text('title').notNull(),
    length: integer('length'),
  },
  (table) => [
    primaryKey({ columns: [table.releaseMbid, table.medium, table.position] }),
    index('mb_release_track_recording_idx').on(table.recordingMbid),
  ],
);

/** `matched_by` kept because ISRC and release position deserve different trust. */
export const trackRecording = sqliteTable(
  'track_recording',
  {
    spotifyTrackId: text('spotify_track_id')
      .primaryKey()
      .references(() => spotifyTrack.spotifyId),
    recordingMbid: text('recording_mbid').notNull(),
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

// Human and bot edits are recorded identically. `outcome` stays `pending` until the edit is seen to
// land: MusicBrainz edits are voted on.
export const mbSubmission = sqliteTable(
  'mb_submission',
  {
    id: integer('id').primaryKey(),
    // 'isrc' and 'barcode' are mechanical; 'release', 'work' and 'work_relationship' stay human.
    kind: text('kind', {
      enum: ['isrc', 'barcode', 'streaming_url', 'release', 'work', 'work_relationship', 'error'],
    }).notNull(),
    /** Null when the entity does not exist yet. */
    targetMbid: text('target_mbid'),
    /** The Spotify track or album the evidence comes from. */
    subject: text('subject').notNull(),
    value: text('value'),
    evidence: text('evidence', { mode: 'json' }).$type<Record<string, unknown>>(),
    /** 'human:<name>' or 'bot:prelude_fm_bot'. */
    submittedBy: text('submitted_by').notNull(),
    submittedAt: integer('submitted_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    editId: text('edit_id'),
    outcome: text('outcome', { enum: ['pending', 'applied', 'rejected', 'withdrawn'] })
      .default('pending')
      .notNull(),
    outcomeAt: integer('outcome_at', { mode: 'timestamp_ms' }),
    note: text('note'),
  },
  (table) => [
    // One submission in hand per value per target. Rejected and withdrawn rows are history.
    uniqueIndex('mb_submission_identity_idx')
      .on(table.kind, table.targetMbid, table.value)
      .where(sql`${table.outcome} in ('pending', 'applied')`),
    index('mb_submission_outcome_idx').on(table.outcome),
    index('mb_submission_subject_idx').on(table.subject),
  ],
);

/** One row per check, overwritten each run. */
export const mbInvariantResult = sqliteTable('mb_invariant_result', {
  name: text('name').primaryKey(),
  severity: text('severity', { enum: ['hard', 'upstream', 'review'] }).notNull(),
  violations: integer('violations').notNull(),
  samples: text('samples', { mode: 'json' }).$type<{ id: string; detail: string | null }[]>(),
  checkedAt: integer('checked_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  // The daily sweep's pass in progress: it has read the check's table up to rowid `sweep_cursor` of
  // `sweep_end` (the last rowid when the pass began) and found `sweep_violations` so far. Null
  // when no pass is under way; a finished pass moves its count into `violations`.
  sweepCursor: integer('sweep_cursor'),
  sweepEnd: integer('sweep_end'),
  sweepViolations: integer('sweep_violations'),
  sweepSamples: text('sweep_samples', { mode: 'json' }).$type<
    { id: string; detail: string | null }[]
  >(),
  sweepStartedAt: integer('sweep_started_at', { mode: 'timestamp_ms' }),
});

// Cached because each stage costs live MusicBrainz requests. `seeded` is the form actually opened,
// untouched by re-preparing. `missing-release-store.ts` maps stage to value type.
export const mbMissingRelease = sqliteTable(
  'mb_missing_release',
  {
    spotifyAlbumId: text('spotify_album_id')
      .notNull()
      .references(() => spotifyAlbum.spotifyId),
    stage: text('stage', { enum: ['precheck', 'seed', 'seeded', 'correction'] }).notNull(),
    value: text('value', { mode: 'json' })
      .$type<ReleasePrecheck | SeedPlan | ReleaseCorrectionRecord>()
      .notNull(),
    // A seed's count excludes its pre-check. Null for corrections measured before they were
    // counted.
    requests: integer('requests'),
    recordedAt: integer('recorded_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.spotifyAlbumId, table.stage] })],
);

// Approving records only agreement; the ledger records the edit. Null `proposal` means the run
// found nothing, kept visible.
export const mbWorkProposal = sqliteTable(
  'mb_work_proposal',
  {
    recordingMbid: text('recording_mbid').primaryKey(),
    releaseMbid: text('release_mbid'),
    proposal: text('proposal', { mode: 'json' }).$type<WorkProposal>(),
    /** `proposal.workMbid`, as a column to join on. */
    workMbid: text('work_mbid'),
    status: text('status', { enum: ['proposed', 'approved', 'dismissed'] })
      .default('proposed')
      .notNull(),
    requests: integer('requests').notNull(),
    checkedAt: integer('checked_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('mb_work_proposal_status_idx').on(table.status),
    index('mb_work_proposal_work_idx').on(table.workMbid),
  ],
);

// What the catalogue's composer list shows, counted ahead of time: counting it on each view would
// read every held work link in the library. A row per composer of a work in the index (found by the
// refresh), null counts until it is first counted. Written by the daily refresh, by
// `pnpm catalog:count`, and whenever someone opens the composer.
export const catalogComposer = sqliteTable(
  'catalog_composer',
  {
    composerMbid: text('composer_mbid').primaryKey(),
    /** Works in the index, at the library's level. */
    works: integer('works'),
    /** Of those, works with a playable recording. */
    playableWorks: integer('playable_works'),
    /** Distinct recordings (or unanchored tracks) across them. */
    recordings: integer('recordings'),
    countedAt: integer('counted_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('catalog_composer_playable_idx').on(table.playableWorks),
    index('catalog_composer_counted_idx').on(table.countedAt),
  ],
);

// Our own claim, kept apart so no MusicBrainz read overwrites it; ignored once the track is
// anchored. `work_mbid` is set only for a confident match; a weaker guess stays in `match`. Null
// `match`: nothing found.
export const trackWorkLink = sqliteTable(
  'track_work_link',
  {
    spotifyTrackId: text('spotify_track_id')
      .primaryKey()
      .references(() => spotifyTrack.spotifyId),
    workMbid: text('work_mbid'),
    match: text('match', { mode: 'json' }).$type<TrackWorkMatch>(),
    requests: integer('requests').notNull(),
    checkedAt: integer('checked_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index('track_work_link_work_idx').on(table.workMbid)],
);
