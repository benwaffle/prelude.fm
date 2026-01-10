"use server";

import { generateText, Output } from "ai";
import { z } from "zod";

const classicalMetadataSchema = z.object({
  isClassical: z.boolean(),
  composerName: z.string().nullable().describe("The name of the composer (e.g. 'Johann Sebastian Bach', 'Wolfgang Amadeus Mozart'). Should match one of the artist names provided. Null if not classical or unknown"),
  formalName: z.string().describe("The formal title of the entire work, e.g. 'Piano Concerto No. 3 in D minor', excluding catalog numbers or movement names"),
  nickname: z.string().nullable().describe("Popular nickname like 'Moonlight Sonata', null if none"),
  catalogSystem: z.string().nullable().describe("Catalog system: Op, RV, BWV, K, Kk, Hob, D, S, etc. Null if not classical or no catalog number. If the work has multiple catalog numbers, pick the most popular one (e.g. for Vivaldi, with Op and RV, pick RV)"),
  catalogNumber: z.string().nullable().describe("Catalog number like '30', '30/3', '582', etc. Null if none"),
  key: z.string().nullable().describe("Musical key like 'D minor', 'C major', or null if unknown or not applicable"),
  form: z.string().nullable().describe("Musical form: 'concerto', 'sonata', 'symphony', 'fugue', 'prelude', etc. Null if not classical"),
  movement: z.number().nullable().describe("Movement number (1, 2, 3, etc.), null if not applicable or unknown"),
  movementName: z.string().nullable().describe("Movement name like 'Finale: Alla breve', 'Allegro', null if unknown"),
  yearComposed: z.number().nullable().describe("Year the piece was composed, if known by the LLM (not expected to be in the title)"),
});

export type ClassicalMetadata = z.infer<typeof classicalMetadataSchema>;

export async function parseTrackMetadata(trackName: string, artistNames?: string[]): Promise<ClassicalMetadata> {
  const artistsText = artistNames && artistNames.length > 0
    ? artistNames.length === 1
      ? ` by ${artistNames[0]}`
      : ` by ${artistNames.join(", ")}`
    : "";

  const prompt = `Parse this classical music track name: "${trackName}"${artistsText}`;

  console.log("AI Prompt:", prompt);

  const { output } = await generateText({
    model: "openai/gpt-5-mini",
    prompt,
    output: Output.object({
      schema: classicalMetadataSchema
    })
  });

  console.log("AI Response:", JSON.stringify(output, null, 2));

  return output;
}

const emptyMetadata: ClassicalMetadata = {
  isClassical: false,
  composerName: null,
  formalName: "",
  nickname: null,
  catalogSystem: null,
  catalogNumber: null,
  key: null,
  form: null,
  movement: null,
  movementName: null,
  yearComposed: null,
};

export async function parseBatchTrackMetadata(
  tracks: Array<{ trackName: string; artistNames: string[] }>
): Promise<ClassicalMetadata[]> {
  // Process tracks in parallel (but limit concurrency to avoid rate limits)
  const batchSize = 10;
  const results: ClassicalMetadata[] = [];

  for (let i = 0; i < tracks.length; i += batchSize) {
    const batch = tracks.slice(i, i + batchSize);
    const batchPromises = batch.map(async ({ trackName, artistNames }) => {
      try {
        return await parseTrackMetadata(trackName, artistNames);
      } catch (err) {
        console.error(`Failed to parse track "${trackName}":`, err);
        return emptyMetadata;
      }
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
  }

  return results;
}
