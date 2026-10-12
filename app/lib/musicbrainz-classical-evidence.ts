// A work relation alone isn't proof of classical (MusicBrainz files pop songs as works too).
// Evidence is a catalogue-series reference, an art-music work type, or a catalogued composer; else
// inconclusive, visibly.

import { ancestry } from './musicbrainz-work-tree';

// Excludes Song, Other, Musical, Play, Prose, Audio drama and Soundtrack, which say nothing either
// way.
const CLASSICAL_WORK_TYPES = new Set([
  'aria',
  'ballet',
  'cantata',
  'concerto',
  'étude',
  'etude',
  'incidental music',
  'madrigal',
  'mass',
  'motet',
  'opera',
  'operetta',
  'oratorio',
  'overture',
  'partita',
  'quartet',
  'sonata',
  'song-cycle',
  'song cycle',
  'suite',
  'symphonic poem',
  'symphony',
  'zarzuela',
]);

export type ClassicalEvidenceWork = {
  mbid: string;
  type: string | null;
  parentMbid: string | null;
  composerMbid?: string | null;
};

export type ClassicalEvidence =
  | { state: 'classical'; reason: string }
  | { state: 'inconclusive'; reason: string };

export function classicalEvidenceFor(
  workMbids: string[],
  workByMbid: Map<string, ClassicalEvidenceWork>,
  catalogedWorkMbids: Set<string>,
  catalogedComposerMbids: Set<string> = new Set(),
): ClassicalEvidence {
  if (workMbids.length === 0) {
    return { state: 'inconclusive', reason: 'MusicBrainz relates this recording to no work' };
  }
  for (const workMbid of workMbids) {
    const chain = ancestry(workMbid, workByMbid);
    if (chain.length === 0) {
      continue;
    }
    const cataloged = chain.find((work) => catalogedWorkMbids.has(work.mbid));
    if (cataloged) {
      return {
        state: 'classical',
        reason: `MusicBrainz gives ${cataloged.mbid} a catalogue-series reference`,
      };
    }
    const typed = chain.find(
      (work) => work.type && CLASSICAL_WORK_TYPES.has(work.type.trim().toLowerCase()),
    );
    if (typed) {
      return {
        state: 'classical',
        reason: `MusicBrainz types ${typed.mbid} as ${typed.type}`,
      };
    }
  }
  for (const workMbid of workMbids) {
    const composed = ancestry(workMbid, workByMbid).find(
      (work) => work.composerMbid && catalogedComposerMbids.has(work.composerMbid),
    );
    if (composed) {
      return {
        state: 'classical',
        reason: `MusicBrainz catalogues other works by ${composed.composerMbid}, the composer of ${composed.mbid}`,
      };
    }
  }
  const knownTypes = workMbids
    .flatMap((workMbid) => ancestry(workMbid, workByMbid))
    .map((work) => work.type)
    .filter((type): type is string => !!type);
  return {
    state: 'inconclusive',
    reason: knownTypes.length
      ? `no catalogue reference, and ${[...new Set(knownTypes)].join('/')} does not distinguish art music`
      : 'no catalogue reference and no work type in the cache',
  };
}
