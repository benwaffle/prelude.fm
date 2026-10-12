// Reads library evidence to say which claimant keeps the code; changes nothing. Shapes seen: a code
// slid one track along, the same performance entered twice (merge), one code on every movement.
// Anything else stays undecided and says why.

export const CONTESTED_LENGTH_TOLERANCE_MS = 3_000;
/** Tighter than the position check: neighbouring short movements can sit a second apart. */
export const DUPLICATE_LENGTH_TOLERANCE_MS = 2_000;

export type ContestedClaimant = {
  recordingMbid: string;
  title: string | null;
  lengthMs: number | null;
  /** A code a Spotify track confirms is the recording's own. */
  confirmedOtherIsrcs: string[];
};

export type ContestedCarrier = {
  spotifyTrackId: string;
  durationMs: number;
  positionalRecordingMbid: string | null;
  positionalLengthMs: number | null;
};

export type ContestedIsrcVerdict =
  | {
      kind: 'owner';
      ownerMbid: string;
      basis: 'release-position' | 'length';
      remove: string[];
      duplicates: string[];
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
    // Nothing in the library carries the code; it can still be ruled out when each claimant has a
    // code of its own.
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
