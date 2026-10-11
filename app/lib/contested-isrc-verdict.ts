/**
 * Which of the recordings sharing an ISRC is the one it belongs to.
 *
 * MusicBrainz should map an ISRC to one recording. When it maps one to
 * several, anchoring refuses to choose, and that is still right: a matcher
 * that guesses here is how a wrong link gets in. But a person fixing the
 * error upstream needs to know which recording keeps the code and which
 * lose it, and our own library often settles that with evidence we already
 * hold. This reads that evidence; it changes nothing.
 *
 * Three shapes turn up in practice:
 *
 * - The code slid one track along a release, so each recording carries its
 *   own ISRC and its neighbour's. The Spotify track carrying the code sits at
 *   a position on its own release whose recording runs the same length, and
 *   the other claimant already has a code of its own that a Spotify track
 *   confirms. The other claimant should lose it.
 * - The same performance was entered twice. Both claimants run the same
 *   length and neither has another code. The fix is a merge, not a removal.
 * - One code was put on every movement of a work. No library track carries
 *   it, and every movement already has its own code confirmed by a Spotify
 *   track. None of them looks like its owner.
 *
 * Anything else stays undecided and says why.
 */

/** Within this, a position on the album's own release is confirmed by length. */
export const CONTESTED_LENGTH_TOLERANCE_MS = 3_000;
/**
 * Two claimants this close in length, with no other code between them, are
 * read as one performance entered twice. Tighter than the position check:
 * neighbouring short movements can sit a second apart, and those are told
 * apart by each carrying a code of its own.
 */
export const DUPLICATE_LENGTH_TOLERANCE_MS = 2_000;

export type ContestedClaimant = {
  recordingMbid: string;
  title: string | null;
  lengthMs: number | null;
  /**
   * Other ISRCs this recording carries that a library track anchored to it
   * also carries. A code a Spotify track confirms is the recording's own.
   */
  confirmedOtherIsrcs: string[];
};

/** A library track whose Spotify ISRC is the contested one. */
export type ContestedCarrier = {
  spotifyTrackId: string;
  durationMs: number;
  /**
   * The recording at this track's disc and position on the release its
   * album's barcode identifies, or null when there is no such release or
   * nothing at that position.
   */
  positionalRecordingMbid: string | null;
  /** That release track's own length, used when the recording has none. */
  positionalLengthMs: number | null;
};

export type ContestedIsrcVerdict =
  | {
      kind: 'owner';
      ownerMbid: string;
      /**
       * `release-position`: a carrier sits at this recording's position on
       * its own release and the lengths agree. `length`: no carrier could be
       * placed, but only this claimant runs the carriers' length.
       */
      basis: 'release-position' | 'length';
      /** Claimants that are different recordings and should lose the code. */
      remove: string[];
      /** Claimants that look like this very performance entered again. */
      duplicates: string[];
      /** Claimants the evidence says nothing about. */
      unclear: string[];
    }
  | { kind: 'stray' }
  | { kind: 'undecided'; reason: string };

function lengthsAgree(a: number | null, b: number | null, toleranceMs: number): boolean {
  return a != null && b != null && Math.abs(a - b) <= toleranceMs;
}

export function judgeContestedIsrc(
  claimants: ContestedClaimant[],
  carriers: ContestedCarrier[],
): ContestedIsrcVerdict {
  const byMbid = new Map(claimants.map((claimant) => [claimant.recordingMbid, claimant]));

  const placed = new Set<string>();
  for (const carrier of carriers) {
    const claimant = carrier.positionalRecordingMbid
      ? byMbid.get(carrier.positionalRecordingMbid)
      : undefined;
    if (!claimant) continue;
    const length = claimant.lengthMs ?? carrier.positionalLengthMs;
    if (lengthsAgree(length, carrier.durationMs, CONTESTED_LENGTH_TOLERANCE_MS)) {
      placed.add(claimant.recordingMbid);
    }
  }
  if (placed.size > 1) {
    return {
      kind: 'undecided',
      reason: 'Library tracks with this ISRC sit on different recordings of their own releases',
    };
  }

  let owner: ContestedClaimant | undefined;
  let basis: 'release-position' | 'length' | undefined;
  if (placed.size === 1) {
    owner = byMbid.get([...placed][0]);
    basis = 'release-position';
  } else if (carriers.length > 0) {
    const fits = claimants.filter((claimant) =>
      carriers.every((carrier) =>
        lengthsAgree(claimant.lengthMs, carrier.durationMs, CONTESTED_LENGTH_TOLERANCE_MS),
      ),
    );
    if (fits.length === 1) {
      owner = fits[0];
      basis = 'length';
    } else {
      return {
        kind: 'undecided',
        reason:
          fits.length === 0
            ? 'No recording runs the length of the library track with this ISRC'
            : 'Several recordings run the length of the library track with this ISRC',
      };
    }
  }

  if (!owner || !basis) {
    // Nothing in the library carries the code. It can still be ruled out for
    // every claimant, when each one is shown to have a code of its own.
    return claimants.every((claimant) => claimant.confirmedOtherIsrcs.length > 0)
      ? { kind: 'stray' }
      : { kind: 'undecided', reason: 'No library track carries this ISRC' };
  }

  const remove: string[] = [];
  const duplicates: string[] = [];
  const unclear: string[] = [];
  for (const claimant of claimants) {
    if (claimant.recordingMbid === owner.recordingMbid) continue;
    if (claimant.confirmedOtherIsrcs.length > 0) {
      remove.push(claimant.recordingMbid);
    } else if (lengthsAgree(claimant.lengthMs, owner.lengthMs, DUPLICATE_LENGTH_TOLERANCE_MS)) {
      duplicates.push(claimant.recordingMbid);
    } else if (
      claimant.lengthMs != null &&
      owner.lengthMs != null &&
      !lengthsAgree(claimant.lengthMs, owner.lengthMs, CONTESTED_LENGTH_TOLERANCE_MS)
    ) {
      remove.push(claimant.recordingMbid);
    } else {
      unclear.push(claimant.recordingMbid);
    }
  }
  return { kind: 'owner', ownerMbid: owner.recordingMbid, basis, remove, duplicates, unclear };
}
