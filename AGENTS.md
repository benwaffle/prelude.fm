# Classical Music Streaming App

We're building a streaming site optimized for classical music that uses spotify as the backend.

It uses NextJS on Vercel for frontend and edge api routes, with Turso Cloud (built on libSQL) as the DB. I aim to minimize the user data we store to the required better-auth tables. The main purpose of the DB is to store classical music metadata.

## Planned Features

- short term
  - understanding of additional metadata, and ability to search & navigate by these
    - catalog sections
    - works identified via catalog numbers, and opus
    - movements
    - recordings
    - nicknames ("Moonlight sonata")
  - Liked songs should be the home page. grouped by catalog number and recording
  - support users who only mark specific movements as 'liked' instead of the whole work
  - sort recordings by spotify popularity field
- long term
  - music discovery features - not sure how yet
  - sheet music integration - IMSLP, musescore

## Use cases

When first opening the app, we open the user's liked songs, and match all spotify track IDs to work+recording.
The tracks that are unmatched will be hidden. The user can see this list separately and submit missing tracks to the matching service. This should be possible for any playlist

The user should be able to click on a track's catalog number to see other recordings, sorted by popularity. Movements in a recording are always displayed together.

The user should be able to click on a track's composer to see popular works.

The user should be able to search for composer or work.

## Don't paper over data issues in the UI

The metadata is incomplete and will stay that way for a while. When the UI meets
a gap, it must **show the gap**, not disguise it. The UI is how we find out what
the pipeline still owes us — hiding a gap costs us that signal and quietly lies
to the reader.

Concretely, don't:

- invent a placeholder that reads like real data (`"Movement 3"`, `"Unknown
performer"`, an era guessed from a missing birth year)
- silently drop rows we can't render — a work whose recording has no matched
  tracks still belongs in the list, marked
- substitute a proxy for a missing field and present it as the real thing (e.g.
  ranking by recording count while calling it popularity)
- imply an ordering that the data can't support

Instead: leave it blank, or label it as missing/unmatched, and keep the row
visible. Preferring the better of two _real_ values (the fullest recording of a
work, the credited artist when the composer is the only artist) is fine — that's
a choice between things we actually know.

Run `pnpm metadata:validate` to check MusicBrainz cache invariants. Hard
violations must be clean. Its non-failing findings are visible gaps, not an
instruction to invent values or merge identities automatically. Use
`pnpm metadata:validate --details` for samples or
`pnpm --silent metadata:validate --json` for machine-readable output. See
`docs/metadata-quality.md`.

## Threads: orchestrator vs implementor

Run `bb status --json` to see which you are. If `.thread.parentThreadId` is
null you're the orchestrator; if it's set you're a child (implementor) of that
thread. (`bb thread show <id>` also prints `Parent:` when there is one.)

**Orchestrator (no parent)** — talks to the user and coordinates:

- Does no implementation itself: code changes, fixes, PRs, prod data changes
  and upstream contributions all go to child threads.
- May read code, query data and run quick checks, but only to diagnose and
  write a precise child prompt (findings, file paths, constraints, what "done"
  means).
- Spawns children with `bb thread spawn --project <id> --parent-self
--provider claude-code --title ... --prompt-file ...` (Claude Code, since
  Codex usage is limited).
- Relays child results to the user faithfully, including failures and open
  decisions. It doesn't make outward-facing decisions on the user's behalf.
- Archives finished and superseded threads (`bb thread archive`) so the list
  shows only live work.

**Child / implementor (has a parent)** — owns one task end to end:

- Does the work in its own environment and follows the rest of this file
  (backups before prod data changes, don't paper over data gaps,
  `pnpm metadata:validate`).
- Ships a prod change through a PR merged to master: typecheck, lint, test and
  build pass, CI green, production deploy and https://prelude.fm/api/health
  confirmed.
- Doesn't spawn threads or message threads other than its parent unless its
  prompt says so. When blocked on a user decision, asks the parent rather than
  guessing.
- Ends with a report to the parent: what changed, evidence (checks, PR link,
  rows changed plus backup path), and anything skipped or unresolved.
- Leaves outward-facing actions outside this repo (e.g. opening PRs on other
  projects) until the user explicitly approves them.

## Tools

Use `turso db shell spotify-classical "<query>"` to execute SQL queries

## Tips

- Take a backup of the DB before mutating prod data or schema.
- Short downtime is OK, I'm the only user.
- We're doing CI/CD, so prod deploys are done by landing commits on main
- Merge PRs with squash (`gh pr merge --squash`); merge commits are disabled.
- copy .envrc from ~/dev/classical
