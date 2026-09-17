# Metadata quality and production operations

## Hard invariants

The production metadata is structurally valid only when all of the following hold:

- every part-linked track belongs to exactly one recording;
- every recording member has at least one part link;
- every linked part belongs to the recording’s work;
- `(work_id, position)` is unique in `work_part_v2`;
- each Spotify track belongs to at most one recording;
- combined tracks may retain multiple part links;
- split movements may link one part to multiple tracks;
- every stored unlinked track is explicitly terminal `not_classical` rather than silently unexplained; and
- no two works of one composer share a canonical catalog identity.

`pnpm metadata:validate` is both the structural validator and metadata audit. Its output separates `hardInvariants` from the non-failing `reviewBacklog`. A nonzero `needsReview` count is reported but is not itself a structural failure: review flags represent semantic uncertainty that was preserved instead of overwritten.

`duplicateCatalogWorks` is a hard invariant rather than a review item because it is not a similarity guess. Same composer plus same canonical catalog identity means two rows claim to be the same work, and `upsertWork` then rejects that identity as ambiguous, so ingestion of the affected work stops until the rows are collapsed. `pnpm metadata:dedupe-works` reports the groups and `--apply` collapses them.

The default human-readable report includes counts plus five representative rows for each nonempty backlog or violation. Use `pnpm metadata:validate --details` for complete affected-row lists. For automation, `pnpm --silent metadata:validate --json` emits strict summary JSON; add `--details` when the consumer also needs every affected ID and duplicate-candidate group.

## Meaning of review status

`confirmed` means the assignment passed deterministic reconciliation. It does not mean the musicological interpretation has been independently verified against a score or authoritative catalog.

`needs_review` is used when:

- a requested canonical position conflicts with an incompatible existing part;
- the pipeline retained an interim/manual fallback link;
- no part was returned and a fallback part had to be synthesized; or
- migration/reparse evidence was ambiguous or less specific than trusted existing metadata.

Do not clear review status in bulk merely to reach zero. Resolve the underlying work, part, or recording ambiguity first.

## Recording a review decision

The review backlog is a queue, not a census. Some gaps are not tasks: `Traditional`
has no birth year, a soundtrack cue is not written in a catalogued form, and a
single-movement work's only part has no movement name to give it. Counting those
forever would bury the gaps that someone can still close.

A gap leaves the backlog only when a row in `metadata_migration_audit` records
who ruled on it and why. The validator subtracts exactly those rows and prints
what it subtracted under **Closed by a recorded review decision**, so the numbers
never quietly shrink.

| `entity_type`        | `decision`           | Means                                                                |
| -------------------- | -------------------- | -------------------------------------------------------------------- |
| `work`               | `keep_separate`      | Shares a title or catalog with another work but is a different piece |
| `work`               | `no_form`            | Not written in a catalogued classical form                           |
| `composer`           | `no_birth_year`      | No source states one, or the row is not one person                   |
| `work_part_v2`       | `no_part_name`       | Single-movement work whose only part the work title already names    |
| `recording_v2`       | `unmatched_on_album` | The album contributes no matched track to this work                  |
| `track_work_part_v2` | `unresolved_link`    | The source does not establish which part the track is                |

`source_id` is the row's id as text; for a link it is `<spotifyTrackId>:<workPartId>`.
Write the reason in full sentences — it is the whole value of the row. Deleting
the audit row puts the item back in the backlog, which is the right move when new
evidence arrives.

## Production snapshot

As of 2026-08-31, after the catalog-identity deduplication and the review pass
that cleared the backlog:

| Metric                             | Count |
| ---------------------------------- | ----: |
| Stored Spotify tracks              | 9,960 |
| Tracks with canonical part links   | 9,696 |
| Track-to-part links                | 9,989 |
| Works                              | 3,128 |
| Composers                          |   651 |
| Work parts                         | 8,113 |
| Recordings                         | 4,452 |
| Queue `matched`                    | 9,248 |
| Queue `not_classical`              |   318 |
| Outstanding review-backlog items   |     0 |
| Gaps closed by a recorded decision |   359 |

Every hard invariant is zero. This table is an operational snapshot, not a test
fixture: counts will change as albums are added, and the zero-valued invariant
rows should remain zero.

The 2026-08-30 snapshot listed 3,462 works and 175 `needs_review` links. The work
count fell because 309 rows were duplicates of works already present — the same
catalog reference spelled differently — not because any music was dropped; the
tracks moved to the surviving work.

## Known quality decisions

- Hans Zimmer was removed from classical metadata. His 288 affected tracks remain as Spotify source rows and terminal `not_classical` queue rows so routine processing does not recreate the assignments.
- The Nutcracker ballet (`Op. 71`) and Nutcracker Suite (`Op. 71a`) are distinct works. Duplicate identities inside each work were merged; the ballet’s `12c` and `12d` are distinct parts.
- Tchaikovsky’s String Quartet No. 1 (`Op. 11`) has one canonical work identity.
- Beethoven’s Ninth (`Op. 125`) has one canonical work identity. Title variants for movements I–IV share canonical parts; explicitly labeled finale subdivisions such as `IVa-b` and `IVc-j` remain separate flat parts.
- Roman numerals are stored labels, not generated from `position`. This prevents duplicated or misleading display numerals.
- `recording_v2.popularity` is the rounded mean of the recording members’ cached Spotify track popularity. Ingestion refreshes it whenever membership changes. Empty recordings remain null and are visibly unranked.
- Queue submission and retry logic preserve terminal `not_classical` rows. On 2026-08-30, 257 unlinked Hans Zimmer rows that had regressed to `pending` were restored to `not_classical`.
- Barber's Op. 11 covers the String Quartet and its derivations. The Adagio for Strings and the Agnus Dei are separately performed pieces with different forces, so the shared opus does not collapse them (`keep_separate`).
- Disc 2 of “Harpsichord Music by the Young J.S. Bach, Vol. 2” carries a contiguous eight-movement keyboard suite (Overture, Aria, Gavotte en Rondeau, Bourrée, Menuets I–III, Gigue). Seven movements had been assigned to BWV 1068, whose movements are Ouverture, Air, Gavotte, Bourrée and Gigue with no Menuets, and the Gigue to BWV 831. They are now their own work with no catalog number, because the album names none.
- Three spoken tracks from “Mozart's Requiem – An Audio Documentary” were linked to Requiem movements. They are talk about the work, not performances of it, and are now terminal `not_classical`.
- A composer is keyed by one Spotify artist id, and Spotify sometimes lists one composer twice (`Jacques Duphly` / `Jaques Duphly`, two `Frank Martin` ids). Those rows stay separate: merging them would drop an artist mapping that ingestion would immediately recreate. Uniting them needs a composer-to-artist relation the schema does not have yet.

Material work merges/removals should be recorded in `metadata_migration_audit` with a reason.

## Known gaps

- **Part canonicalisation across merged works.** Collapsing duplicate works
  brings each source's movement rows with it, and the same movement spelled two
  ways stays two parts. Rows are merged only on the deterministic key the
  validator uses, so the residue is visible rather than guessed at. There is no
  safe general rule: a two-movement `Prelude and Fugue in B-flat major` and a
  single waltz listed twice look alike to every similarity measure tried.
- **Parts with no track links** (129 as of 2026-08-31). Either a movement no
  recording we hold has matched, or a row left behind by a reassignment. Not yet
  measured by the validator, because the two cases need separating first.

## MusicBrainz as a second source

MusicBrainz is used to _corroborate and extend_ the catalogue, never to
overwrite it. The parser remains the source of structure; MusicBrainz fills gaps
the parser left and contributes catalogue references it never had.

The join is the ISRC: Spotify reports one per track, MusicBrainz resolves it to
a recording, and that recording's `performance` relationship reaches a work.
Coverage is bounded by how many of our releases MusicBrainz holds at all —
roughly 40% of tracks resolve today, and a little over half of our albums are
absent from MusicBrainz entirely, so this will never reach 100%.

    pnpm mb:backfill isrcs       Spotify ISRCs -> spotify_track.isrc
    pnpm mb:backfill recordings  ISRC -> spotify_track.mb_recording_id
    pnpm mb:backfill works       recording -> work/part MBIDs, catalogues, facts
    pnpm mb:backfill composers   composer MBIDs -> life dates
    pnpm mb:backfill report      coverage so far

    pnpm mb:promote              report what MusicBrainz could fill
    pnpm mb:promote --apply      write it

`pnpm metadata:validate` reports MusicBrainz coverage, how many empty fields
could be filled, and how many differ from what we hold.

### Rules the import obeys

- **Only empty fields are written.** A field we hold is a claim; if MusicBrainz
  disagrees, both values are kept and the difference is reported. Our `form` is
  frequently more specific than MusicBrainz's 29-term vocabulary, so a
  disagreement usually means ours is better, not wrong.
- **Identity comes from relationships, not names.** A composer is identified by
  the `composer` relationship on a work we matched by ISRC. A name search cannot
  tell four Bachs apart.
- **Split evidence records nothing.** If the parts of one work name different
  MusicBrainz works, or one composer is reached through two MusicBrainz artists,
  nothing is written — choosing would be a guess, and a split vote usually means
  a match further upstream is wrong.
- **Only `Catalogue` series become catalogue numbers.** MusicBrainz also has
  numbered _work_ series; Bach's orchestral suites sit in one numbered 1–4, and
  reading it as a catalogue would file the second suite under catalogue "2".
- **Movement titles lose their parent prefix.** MusicBrainz titles a leaf work
  `"<parent>: <part>"`; importing verbatim would repeat the work's title inside
  every one of its movements.

### When promotion closes a backlog item

Filling a field deletes any `no_birth_year` / `no_form` / `no_part_name`
decision recorded against that row. Those decisions mean "someone looked and the
value genuinely does not exist"; once MusicBrainz supplies one, that statement
is no longer true and leaving it would misinform the next reader.

## Safe repair procedure

Before mutating production data or schema:

1. Resolve exact composer, work, part, recording, and track IDs with read-only SQL.
2. Take a Turso backup.
3. Write down the expected before/after cardinalities and affected Spotify track IDs.
4. Apply the smallest deterministic transaction possible.
5. Run focused SQL checks for the repaired identities.
6. Run `pnpm metadata:validate`, tests, typecheck, lint, and a production build when application code changed.
7. Record merge/removal decisions in `metadata_migration_audit`.
8. Commit only durable application, migration, test, and documentation changes. Do not commit backups or disposable one-off repair scripts.
9. Push the commit to `master`; production deployment happens through GitHub/Vercel CI.

Backup example:

```bash
turso db export spotify-classical \
  --output-file backups/spotify-classical-YYYY-MM-DD-before-description.db \
  --with-metadata
```

Never run an unconstrained bulk LLM reparse directly over trusted production assignments. A previous full reparse demonstrated that syntactically valid output can still move confirmed tracks between works, drop part links, or fragment canonical identities. Reparse into reviewable candidate data or preserve existing work/part evidence, compare diffs, and accept only deterministic improvements.

## Validation queries

The checked-in validator is the source of truth for automated structural checks. These targeted reports are useful during an incident:

```sql
-- Queue state
SELECT status, count(*)
FROM match_queue
GROUP BY status
ORDER BY status;

-- Review backlog
SELECT count(*)
FROM track_work_part_v2
WHERE match_status = 'needs_review';

-- Cross-work corruption: must return zero
SELECT count(*)
FROM track_work_part_v2 link
JOIN work_part_v2 part ON part.id = link.work_part_id
JOIN recording_track_v2 member ON member.spotify_track_id = link.spotify_track_id
JOIN recording_v2 recording ON recording.id = member.recording_id
WHERE part.work_id <> recording.work_id;

-- Duplicate canonical positions: must return no rows
SELECT work_id, position, count(*)
FROM work_part_v2
GROUP BY work_id, position
HAVING count(*) > 1;
```

## Release checklist for metadata changes

- Production backup exists and is not staged in Git.
- Scope IDs and expected row counts were inspected before mutation.
- Previously confirmed assignments outside the repair scope are unchanged.
- Structural validator exits successfully.
- Parser/normalization/recording fixtures pass.
- Typecheck, lint, and build pass for code changes.
- Queue has no unintentionally stuck `processing` rows.
- Data-only fixes are documented in the audit table.
- Code reaches production only through a push to GitHub.
