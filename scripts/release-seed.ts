/**
 * Prepare our MusicBrainz release-editor seed for missing albums, from the
 * command line: which existing recordings would be pre-filled, and why.
 *
 *   pnpm metadata:release-seed --album <id> [--album <id> …]
 *   pnpm metadata:release-seed --album <id> --fields    also print the form fields
 *   pnpm metadata:release-seed --album <id> --no-store  do not store the seed
 *
 * Reads MusicBrainz (interactive channel) and Spotify; submits nothing — the
 * form is only ever POSTed from the admin's own browser.
 */
import { defineScript, UsageError } from './lib/cli';

defineScript(
  {
    options: {
      album: { type: 'string', multiple: true },
      fields: { type: 'boolean' },
      'no-store': { type: 'boolean' },
    },
  },
  async ({ options }) => {
    const albums = options.album;
    if (albums.length === 0) throw new UsageError('Pass --album <spotify album id>');
    const store = !options['no-store'];
    const showFields = options.fields;
    const [run, { seedFields }] = await Promise.all([
      import('@/lib/release-seeding-run'),
      import('@/lib/release-seeding'),
    ]);

    for (const albumId of albums) {
      const { plan, requests } = store
        ? await run.prepareReleaseSeed(albumId)
        : await run.buildReleaseSeed(albumId);
      console.log(`\n${plan.title}  [${albumId}]`);
      console.log(
        `  ${plan.counts.prefilled} of ${plan.counts.tracks} recordings pre-filled · ${plan.counts.ambiguous} ambiguous (left empty) · ${plan.counts.none} new · ${requests} MB requests${store ? ' · stored' : ''}`,
      );
      const via = new Map<string, number>();
      for (const track of plan.tracks) {
        if (track.recording.state === 'matched') {
          via.set(track.recording.via, (via.get(track.recording.via) ?? 0) + 1);
        }
      }
      console.log(
        `  matched via: ${[...via].map(([how, n]) => `${how} ${n}`).join(', ') || 'none'}`,
      );
      console.log(
        `  release group: ${plan.releaseGroupMbid ?? 'none seeded'}${plan.releaseGroupNote ? ` — ${plan.releaseGroupNote}` : ''}`,
      );
      console.log(
        `  positions from: ${plan.editions.map((edition) => `${edition.releaseTitle} ${edition.releaseMbid}`).join('; ') || 'no existing release used'}`,
      );
      console.log(
        `  release artist: ${plan.releaseCredit.map((part) => `${part.name}${part.mbid ? ` (${part.mbid})` : ' (no MBID)'}`).join(', ')}`,
      );
      for (const note of plan.notes) console.log(`  note: ${note}`);
      for (const track of plan.tracks.filter((entry) => entry.recording.state === 'ambiguous')) {
        if (track.recording.state !== 'ambiguous') continue;
        console.log(
          `  ambiguous ${track.disc}.${track.position} “${track.title}”: ${track.recording.reason}`,
        );
      }
      if (showFields) {
        for (const [name, value] of seedFields(plan)) {
          console.log(`    ${name} = ${JSON.stringify(value)}`);
        }
      }
    }
  },
);
