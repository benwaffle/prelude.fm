# Metadata data model

The listener reads Spotify provider data joined to the MusicBrainz cache. Spotify tracks and albums supply playback IDs, titles, artwork, dates, and ISRCs. `track_recording` anchors a Spotify track to a MusicBrainz recording. `mb_release`, `mb_release_track`, `mb_recording`, `mb_recording_work`, `mb_work`, `mb_work_catalogue`, `mb_artist`, and `mb_recording_credit` supply musical metadata. A missing relation is a visible gap. Our own title-based work links stand in only where MusicBrainz has none, and are always shown as ours, with the gap kept.

`track_work_link` and the suggestions in `mb_work_proposal` are prelude.fm's own work links, used only where MusicBrainz has no link; the reader marks them as ours (see `docs/metadata-pipeline.md`).

`match_queue` records processing leases and outcomes. `track_classification` records classical/non-classical decisions and their provenance. Historical parser provenance may still appear on those rows, but no new parser decisions are made. A parser decision is not a MusicBrainz fact.

`mb_submission` records manually confirmed MusicBrainz contributions and bot ISRC submissions. The application does not submit automatically. Gateway, budget, metric, and invariant tables support throttling and health checks.

The only user data stored is in the better-auth tables: `user`, `session`, `account`, and `verification`. The liked-song list is read from Spotify. See `app/lib/db/schema.ts` for columns and relationships.

Migration `0021_condemned_kang` removed the old integer `composer` and `work` graph, six v2 parser tables, and `metadata_migration_audit`. The pre-drop production backup is outside Git.
