# MusicBrainz metadata pipeline

The production match worker runs through `/api/cron/match-queue`. A queued album is read from Spotify, then passed through `runMusicBrainzAlbumPass`. The pass caches MusicBrainz releases, recordings, works, artists, and credits, anchors tracks through ISRC or aligned release position, and records classification and pipeline outcomes. A missing release, recording, work, or settled classification leaves the track unresolved. It does not invoke a language model or invent a work.

`pnpm queue:drain` runs the same queue worker locally. `pnpm mb:ingest` performs bulk cache backfill and read-only reports. `pnpm metadata:validate` checks cache invariants. The MusicBrainz gateway in `app/lib/musicbrainz-gateway.ts` shares request budget and rate limits across workers.

The admin Inbox presents gaps and evidence. It never auto-submits to MusicBrainz. The ISRC bot runs only after an explicit action. Releases, works, and relationships require human editing and confirmation. Recheck reads MusicBrainz to see whether a submitted edit has landed.

Production application deploys occur by pushing commits to `master` and letting GitHub/Vercel deploy. The database migration is applied separately through `pnpm db:migrate`.
