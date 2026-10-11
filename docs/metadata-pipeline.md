# MusicBrainz metadata pipeline

The production match worker runs through `/api/cron/match-queue`. A queued album is read from Spotify, then passed through `runMusicBrainzAlbumPass`. The pass caches MusicBrainz releases, recordings, works, artists, and credits, anchors tracks through ISRC or aligned release position, and records classification and pipeline outcomes. A missing release, recording, work, or settled classification leaves the track unresolved. It does not invoke a language model or invent a work.

`pnpm queue:drain` runs the same queue worker locally. `pnpm mb:ingest` performs bulk cache backfill and read-only reports. `pnpm metadata:validate` checks cache invariants. The MusicBrainz gateway in `app/lib/musicbrainz-gateway.ts` shares request budget and rate limits across workers.

The admin Inbox presents gaps and evidence. It never auto-submits to MusicBrainz. The ISRC bot runs only after an explicit action. Releases, works, and relationships require human editing and confirmation. Recheck reads MusicBrainz to see whether a submitted edit has landed.

`pnpm metadata:work-proposals` proposes a work for each library recording MusicBrainz links to none: parts of works the album's other tracks already perform, then a MusicBrainz work search by title and composer. Each proposal carries a confidence and plain reasons; titles that disagree on a stated number, key or movement are ruled out rather than scored low, and a recording with no candidate is stored as "no proposal". It writes only `mb_work_proposal`. In the Inbox's work section, approving a proposal records only that the person agrees; they enter the links in the album's MusicBrainz relationship editor, then record them as entered, which writes the usual ledger rows for Recheck.

Production application deploys occur by pushing commits to `master` and letting GitHub/Vercel deploy. The database migration is applied separately through `pnpm db:migrate`.
