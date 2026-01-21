'use server';

import { generateText, Output } from 'ai';
import { z } from 'zod';

const classicalMetadataSchema = z.object({
  isClassical: z.boolean(),
  composerName: z
    .string()
    .nullable()
    .describe(
      "The name of the composer (e.g. 'Johann Sebastian Bach', 'Wolfgang Amadeus Mozart'). Should match one of the artist names provided. Null if not classical or unknown",
    ),
  formalName: z
    .string()
    .describe(
      "The formal title of the entire work, e.g. 'Piano Concerto No. 3 in D minor', excluding catalog numbers or movement names",
    ),
  nickname: z
    .string()
    .nullable()
    .describe("Popular nickname like 'Moonlight Sonata', null if none"),
  catalogSystem: z
    .string()
    .nullable()
    .describe(
      'Catalog system: Op, RV, BWV, K, Kk, Hob, D, S, etc. Null if not classical or no catalog number. If the work has multiple catalog numbers, pick the most popular one (e.g. for Vivaldi, with Op and RV, pick RV. for Smetana, pick JB)',
    ),
  catalogNumber: z
    .string()
    .nullable()
    .describe("Catalog number like '30', '30/3', '582', etc. Null if none"),
  form: z
    .string()
    .nullable()
    .describe(
      "Musical form: 'concerto', 'sonata', 'symphony', 'fugue', 'prelude', etc. Null if not classical",
    ),
  movement: z
    .number()
    .nullable()
    .describe('Movement number (1, 2, 3, etc.), null if not applicable or unknown'),
  movementName: z
    .string()
    .nullable()
    .describe(
      "Movement name like 'Finale: Alla breve', 'Allegro', null if unknown. If it is a single-movement work, this can be the key of the piece",
    ),
  yearComposed: z
    .number()
    .nullable()
    .describe('Year the piece was composed, if known by the LLM (not expected to be in the title)'),
});

export type ClassicalMetadata = z.infer<typeof classicalMetadataSchema>;

// Schema for album batch parsing - returns array of metadata for each track
const albumBatchSchema = z.object({
  tracks: z
    .array(classicalMetadataSchema)
    .describe('Metadata for each track in the same order as provided'),
});

// Parse all tracks from an album together for better context
export async function parseAlbumTracks(
  albumName: string,
  tracks: Array<{ trackName: string; artistNames: string[] }>,
): Promise<ClassicalMetadata[]> {
  if (tracks.length === 0) {
    return [];
  }

  // Collect all unique artist names across all tracks
  const allArtists = [...new Set(tracks.flatMap((t) => t.artistNames))];
  const artistsText = allArtists.length > 0 ? `\nArtists on album: ${allArtists.join(', ')}` : '';

  // Format track list
  const trackList = tracks
    .map(
      (t, i) =>
        `${i + 1}. "${t.trackName}"${t.artistNames.length > 0 ? ` (${t.artistNames.join(', ')})` : ''}`,
    )
    .join('\n');

  const prompt = `Parse these classical music tracks from the album "${albumName}":${artistsText}

${trackList}

Return metadata for each track in the same order. Tracks from the same work should have consistent catalog numbers and formal names. Use the album and track context to disambiguate sparse track titles like "I. Allegro" or "Andante".`;

  console.log('AI Album Batch Prompt:', prompt);

  const { output } = await generateText({
    model: 'openai/gpt-5-mini',
    prompt,
    output: Output.object({
      schema: albumBatchSchema,
    }),
  });

  console.log('AI Album Batch Response:', JSON.stringify(output, null, 2));

  if (output.tracks.length !== tracks.length) {
    throw new Error(`Expected ${tracks.length} tracks but LLM returned ${output.tracks.length}`);
  }

  return output.tracks;
}
