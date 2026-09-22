/**
 * Whether MusicBrainz itself says a recording is of art music.
 *
 * The tempting rule — "the recording is related to a work" — is wrong.
 * MusicBrainz files works for popular songs too: a pop single is routinely a
 * recording of a work, and so is a jazz standard. Reading a work relation as
 * proof of classical puts a chart single in the library under a composer,
 * which is worse than leaving it unreviewed.
 *
 * So the evidence has to be specific, and there are only two specific things
 * MusicBrainz says:
 *
 *  - a catalogue-series reference — BWV, K., Ryom, Op. as a series — which
 *    exists because a scholar catalogued a composer's output, and which
 *    popular songs do not have;
 *  - a work type from the art-music part of MusicBrainz's list. Types like
 *    "Song" and "Other" are exactly the ones that do not distinguish, so
 *    they are not evidence either way.
 *
 * Both are checked against the work and its ancestors, because MusicBrainz
 * files the catalogue number and usually the type on the piece, not on its
 * movements.
 *
 * Anything else is inconclusive. Inconclusive is a visible state, not a
 * default to "no": the point is that nobody has established it yet.
 */

/**
 * MusicBrainz work types that only art music carries. Deliberately excludes
 * Song, Other, Musical, Play, Prose, Audio drama and Soundtrack, which say
 * nothing either way.
 */
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
};

export type ClassicalEvidence =
  | { state: 'classical'; reason: string }
  | { state: 'inconclusive'; reason: string };

/** The work and its ancestors, nearest first, stopping at a cycle. */
function ancestry(
  workMbid: string,
  workByMbid: Map<string, ClassicalEvidenceWork>,
): ClassicalEvidenceWork[] {
  const chain: ClassicalEvidenceWork[] = [];
  const seen = new Set<string>();
  let cursor = workByMbid.get(workMbid);
  while (cursor && !seen.has(cursor.mbid)) {
    seen.add(cursor.mbid);
    chain.push(cursor);
    cursor = cursor.parentMbid ? workByMbid.get(cursor.parentMbid) : undefined;
  }
  return chain;
}

export function classicalEvidenceFor(
  workMbids: string[],
  workByMbid: Map<string, ClassicalEvidenceWork>,
  catalogedWorkMbids: Set<string>,
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
