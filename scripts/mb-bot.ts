/**
 * Run prelude_fm_bot's ISRC and barcode submissions.
 *
 *   pnpm mb:bot                    show what would be submitted (ISRCs)
 *   pnpm mb:bot --apply            submit ISRCs
 *   pnpm mb:bot --release <mbid>   a particular release rather than the first
 *   pnpm mb:bot --barcode            show barcode batch (dry run)
 *   pnpm mb:bot --barcode --apply    submit barcodes
 *   pnpm mb:bot --barcode --release <mbid>
 *
 * One album at a time for ISRCs: an album is the unit somebody can actually check,
 * since every row shares a release, a barcode and one tracklist.
 *
 * Dry run by default, and the dry run needs no credentials, so the payload
 * can be read and a sample hand-checked on musicbrainz.org before anything
 * is sent.
 */
import { defineScript } from './lib/cli';

defineScript(
  {
    options: {
      apply: { type: 'boolean' },
      barcode: { type: 'boolean' },
      'max-edits': { type: 'integer', min: 1 },
      release: { type: 'string' },
      payload: { type: 'boolean' },
    },
  },
  async ({ options }) => {
    const { apply, barcode, payload: showPayload } = options;
    const maxEdits = options['max-edits'];
    const releaseMbid = options.release;

    if (barcode) {
      const { runBarcodeBot } = await import('@/lib/musicbrainz-bot');
      const run = await runBarcodeBot({ apply, maxEdits, releaseMbid });

      console.log(apply && run.submitted ? 'Submitted.' : 'Dry run. Pass --apply to submit.');
      console.log(`
  releases in batch       ${run.evidence.length}
  edits in this batch     ${run.edits}
  edits already today     ${run.spentToday} of 1000`);

      console.log(`\n  edit note:\n    ${run.editNote}`);

      if (run.evidence.length > 0) {
        console.log('\n  what would be submitted:');
        for (const gap of run.evidence.slice(0, 8)) {
          console.log(
            `    ${gap.releaseTitle}  ${gap.barcode}  ${gap.trackCount} tracks  worst ${gap.maxDurationDeltaMs}ms`,
          );
          console.log(`         https://open.spotify.com/album/${gap.albumId}`);
        }
      }

      if (showPayload) console.log(`\n${run.payload}`);
      return;
    }

    const { runIsrcBot } = await import('@/lib/musicbrainz-bot');
    const run = await runIsrcBot({ apply, maxEdits, releaseMbid });

    console.log(apply && run.submitted ? 'Submitted.' : 'Dry run. Pass --apply to submit.');
    console.log(`
  album                   ${run.albumTitle ?? '(none outstanding)'}
  edits in this batch     ${run.edits}
  edits already today     ${run.spentToday} of 1000
  recordings addressed    ${new Set(run.items.map((i) => i.recordingMbid)).size}`);

    console.log(`\n  edit note:\n    ${run.editNote}`);

    if (run.evidence.length > 0) {
      const strip = (value: string | null) => (value ?? '').replace(/^0+/, '');
      console.log('\n  what would be submitted:');
      for (const gap of run.evidence.slice(0, 8)) {
        const agree = strip(gap.upc) !== '' && strip(gap.upc) === strip(gap.barcode);
        console.log(
          `    ${gap.medium}-${String(gap.position).padEnd(3)} ${gap.isrc}  ${gap.durationDeltaMs}ms  ${agree ? 'barcode ok' : 'BARCODE MISMATCH'}`,
        );
        console.log(`         ours: ${gap.trackTitle}`);
        console.log(`         them: ${gap.recordingTitle}`);
      }
      console.log(
        `\n  verify a sample: https://musicbrainz.org/recording/${run.evidence[0].recordingMbid}`,
      );
    }

    if (showPayload) console.log(`\n${run.payload}`);
  },
);
