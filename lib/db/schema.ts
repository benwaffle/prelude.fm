import { relations, sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
} from "drizzle-orm/sqlite-core";

/*
 * Better Auth
 */

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .default(false)
    .notNull(),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
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

export const composer = sqliteTable("composer", {
  id: text("id").primaryKey(), // slug: "bach", "mozart"
  name: text("name").notNull(),
  birthYear: integer("birth_year"),
  deathYear: integer("death_year"),
  biography: text("biography"),
  spotifyArtistId: text("spotify_artist_id"),
});

export const work = sqliteTable(
  "work",
  {
    id: text("id").primaryKey(), // "bach/bwv-1052"
    composerId: text("composer_id")
      .notNull()
      .references(() => composer.id),
    title: text("title").notNull(),
    nickname: text("nickname"), // "moonlight", "spring"
    catalogSystem: text("catalog_system").notNull(), // "BWV", "K", "Op"
    catalogNumber: text("catalog_number").notNull(), // "1052", "27/2"
    yearComposed: integer("year_composed"),
    form: text("form"), // "concerto", "sonata", "fugue"
  },
  (table) => [index("work_composer_idx").on(table.composerId)],
);

export const movement = sqliteTable(
  "movement",
  {
    id: text("id").primaryKey(), // "bach/bwv-1052/1"
    workId: text("work_id")
      .notNull()
      .references(() => work.id),
    number: integer("number").notNull(),
    title: text("title"), // "Allegro", null
  },
  (table) => [index("movement_work_idx").on(table.workId)],
);

export const spotifyAlbum = sqliteTable("spotify_album", {
  spotifyId: text("spotify_id").primaryKey(),
  title: text("title").notNull(),
  year: integer("year"),
  popularity: integer("popularity"),
  images: text("images", { mode: "json" }).$type<
    { url: string; width: number; height: number }[]
  >(),
});

export const recording = sqliteTable(
  "recording",
  {
    id: text("id").primaryKey(), // uuid
    spotifyAlbumId: text("spotify_album_id")
      .notNull()
      .references(() => spotifyAlbum.spotifyId),
    workId: text("work_id")
      .notNull()
      .references(() => work.id),
    popularity: integer("popularity"), // calculated by averaging tracks
  },
  (table) => [
    index("recording_work_idx").on(table.workId),
    index("recording_album_idx").on(table.spotifyAlbumId),
  ]
);

export const spotifyTrack = sqliteTable(
  "spotify_track",
  {
    spotifyId: text("spotify_id").primaryKey(),
    title: text("title").notNull(),
    recordingId: text("recording_id")
      .notNull()
      .references(() => recording.id),
    durationMs: integer("duration_ms").notNull(),
    popularity: integer("popularity"),
  },
  (table) => [index("track_recording_idx").on(table.recordingId)],
);

export const spotifyArtist = sqliteTable("spotify_artist", {
  spotifyId: text("spotify_id").primaryKey(),
  name: text("name").notNull(),
  popularity: integer("popularity"),
  images: text("images", { mode: "json" }).$type<
    { url: string; width: number; height: number }[]
  >(),
});

export const trackArtists = sqliteTable(
  "track_artists",
  {
    spotifyTrackId: text("spotify_track_id")
      .notNull()
      .references(() => spotifyTrack.spotifyId),
    spotifyArtistId: text("spotify_artist_id")
      .notNull()
      .references(() => spotifyArtist.spotifyId),
  },
  (table) => [
    primaryKey({ columns: [table.spotifyTrackId, table.spotifyArtistId] }),
  ],
);

export const trackMovement = sqliteTable(
  "track_movement",
  {
    spotifyTrackId: text("spotify_track_id")
      .notNull()
      .references(() => spotifyTrack.spotifyId),
    movementId: text("movement_id")
      .notNull()
      .references(() => movement.id),
    startMs: integer("start_ms"),
    endMs: integer("end_ms"),
  },
  (table) => [
    primaryKey({ columns: [table.spotifyTrackId, table.movementId] }),
  ],
);

export const matchQueue = sqliteTable("match_queue", {
  spotifyId: text("spotify_id").primaryKey(),
  submittedAt: integer("submitted_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  submittedBy: text("submitted_by").notNull(),
  status: text("status").notNull(), // "pending", "matched", "failed"
});

/*
 * Classical Music Relations
 */

export const composerRelations = relations(composer, ({ many }) => ({
  works: many(work),
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

export const spotifyTrackRelations = relations(
  spotifyTrack,
  ({ one, many }) => ({
    recording: one(recording, {
      fields: [spotifyTrack.recordingId],
      references: [recording.id],
    }),
    trackArtists: many(trackArtists),
    trackMovements: many(trackMovement),
  }),
);

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
