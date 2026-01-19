import type { InferSelectModel } from "drizzle-orm";
import {
  composer,
  spotifyArtist,
  spotifyAlbum,
  spotifyTrack,
  work,
  movement,
  trackMovement,
  recording,
} from "@/lib/db/schema";

export type SpotifyTrackRow = InferSelectModel<typeof spotifyTrack>;
export type SpotifyAlbumRow = InferSelectModel<typeof spotifyAlbum>;
export type SpotifyArtistRow = InferSelectModel<typeof spotifyArtist>;
export type ComposerRow = InferSelectModel<typeof composer>;
export type WorkRow = InferSelectModel<typeof work>;
export type MovementRow = InferSelectModel<typeof movement>;
export type TrackMovementRow = InferSelectModel<typeof trackMovement>;
export type RecordingRow = InferSelectModel<typeof recording>;
