# MusicBrainz metadata quality

Run `pnpm metadata:validate` to check the MusicBrainz cache and track anchors. It reports the `musicbrainzInvariants` used by the reader and exits nonzero for hard violations. Use `--details` for more samples or `--json` for machine-readable output. The admin Health tab and scheduled invariant sweep use the same invariant definitions in `app/lib/musicbrainz-invariants.ts`.

An incomplete MusicBrainz record is a visible gap, not a license to guess. Library cards and the gap strip show missing works, parts, composers, and recordings. Recheck fetches MusicBrainz again; it does not create facts or submit edits. Candidate work relationships require explicit human confirmation. ISRC bot submissions require a button press in admin and evidence checks.

The old `hardInvariants` and `reviewBacklog` for the integer parser graph were removed with that graph. Historical parser classifications remain labelled by provenance in `track_classification`; they do not become MusicBrainz facts.
