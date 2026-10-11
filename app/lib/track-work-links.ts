/**
 * Matching a Spotify track straight to a MusicBrainz work, for tracks
 * MusicBrainz cannot reach through a recording (their release is not on
 * MusicBrainz yet).
 *
 * The scoring is the work-proposal matcher's (`work-proposals.ts`): the same
 * contradictions rule a candidate out — a different catalogue number, key or
 * movement number — and the same signals rank the rest. What differs is what
 * happens to the winner. A proposal waits for a person; a link is used by the
 * reader straight away. So the bar here is higher: only a high-confidence
 * match whose composer is credited on the Spotify track is linked, and
 * anything weaker is kept as a visible, unlinked best guess.
 *
 * Pure: the run that searches MusicBrainz and stores links is in
 * `track-work-links-run.ts`.
 */
import {
  candidateSignals,
  movementNumber,
  normalizeTitle,
  numberRefs,
  type ProposalCandidate,
  type ProposalTarget,
  type WorkProposal,
} from './work-proposals';

export type TrackWorkMatch = WorkProposal & {
  /** Whether the reader uses this match. */
  linked: boolean;
  /** Why a best guess is not used, in plain words; null when it is linked. */
  heldBack: string | null;
};

const TRAILING_LABEL =
  /\s+[-–—]\s+(?:live|remaster(?:ed)?|\d{4} remaster(?:ed)?|remastered \d{4}|mono|stereo)\b.*$/i;

/**
 * The track title with what Spotify adds around the piece's own name: a
 * leading "Handel: " naming a credited artist, and a trailing " - Live" or
 * " - Remastered 2015".
 *
 * Two separators are also read the way MusicBrainz writes them, so the
 * movement numeral lands in the last section where the matcher looks for it:
 * a " - " between a collection and its member becomes ": " ("Op. 8 -
 * Concerto No. 1"), and a movement's own heading and tempo stay one section
 * ("III. Danza pastorale: Allegro" → "III. Danza pastorale, Allegro").
 */
export function cleanTrackTitle(title: string, artistNames: readonly string[]): string {
  let cleaned = title.replace(TRAILING_LABEL, '').trim();
  const colon = cleaned.indexOf(':');
  if (colon > 0) {
    const prefix = normalizeTitle(cleaned.slice(0, colon));
    const credited = artistNames.some((name) => {
      const full = normalizeTitle(name);
      const surname = full
        .split(/[^a-z]+/)
        .filter(Boolean)
        .at(-1);
      return prefix === full || (surname !== undefined && prefix === surname);
    });
    if (credited) cleaned = cleaned.slice(colon + 1).trim();
  }

  // "… BWV 1052 - Allegro risoluto": a tempo after a dash, with no colon.
  const tail = /^(.*\d.*?)\s[-–]\s([^:\-–]+)$/.exec(cleaned);
  if (!cleaned.includes(':') && tail && tail[2].trim().split(/\s+/).length <= 4) {
    cleaned = `${tail[1].trim()}: ${tail[2].trim()}`;
  }

  const firstColon = cleaned.indexOf(':');
  const head = firstColon === -1 ? cleaned : cleaned.slice(0, firstColon);
  const dash = head.search(/\s[-–]\s/);
  if (dash > 0 && firstColon !== -1) {
    cleaned = `${head.slice(0, dash).trim()}: ${cleaned.slice(dash + 3).trim()}`;
  }

  const sections = cleaned.split(':').map((section) => section.trim());
  const numbered = sections.findIndex((section, index) => index > 0 && MOVEMENT_HEAD.test(section));
  if (numbered > 0 && numbered < sections.length - 1) {
    return [...sections.slice(0, numbered), sections.slice(numbered).join(', ')].join(': ');
  }
  return sections.join(': ');
}

const MOVEMENT_HEAD = /^([ivxIVX]+|\d{1,2})[.)]\s/;

/** Whether a best guess is good enough for the reader to use. */
export function linkDecision(proposal: WorkProposal): { linked: boolean; heldBack: string | null } {
  if (proposal.confidence !== 'high') {
    return {
      linked: false,
      heldBack: `Only ${proposal.confidence} confidence; a link needs high confidence.`,
    };
  }
  if (!proposal.signals.composerMatch) {
    return {
      linked: false,
      heldBack: proposal.composerName
        ? `Composer ${proposal.composerName} is not credited on the Spotify track.`
        : 'MusicBrainz has no composer on this work, so nothing confirms it.',
    };
  }
  return { linked: true, heldBack: null };
}

export function asTrackWorkMatch(proposal: WorkProposal): TrackWorkMatch {
  return { ...proposal, ...linkDecision(proposal) };
}

/**
 * Two tracks on one album linked to the same work. A deliberate repeat — an
 * album of five conductors playing the same movement — carries the same
 * title each time, and stays. Otherwise one of them is more likely wrong, so
 * every track but the closest title loses its link, saying why.
 */
export function unlinkSharedMatches(
  rows: readonly { spotifyTrackId: string; title: string; match: TrackWorkMatch | null }[],
): void {
  const byWork = new Map<string, { title: string; match: TrackWorkMatch }[]>();
  for (const row of rows) {
    if (!row.match?.linked) continue;
    const list = byWork.get(row.match.workMbid) ?? [];
    list.push({ title: row.title, match: row.match });
    byWork.set(row.match.workMbid, list);
  }
  for (const list of byWork.values()) {
    if (list.length < 2) continue;
    if (new Set(list.map((row) => normalizeTitle(row.title))).size === 1) continue;
    list.sort((a, b) => b.match.signals.titleScore - a.match.signals.titleScore);
    for (const row of list.slice(1)) {
      row.match.linked = false;
      row.match.heldBack = `The same work is matched to “${list[0].title}” on this album.`;
    }
  }
}

/** A work MusicBrainz says is the piece the track names, by catalogue number and composer. */
export type ConfirmedWork = {
  workMbid: string;
  title: string;
  composerName: string;
  /** The catalogue number both the track title and MusicBrainz give, e.g. `BWV 1042`. */
  number: string;
};

function surnameOf(name: string): string | null {
  return (
    normalizeTitle(name)
      .split(/[^a-z]+/)
      .filter(Boolean)
      .at(-1) ?? null
  );
}

/**
 * Whether a work read from MusicBrainz is the piece the track title names:
 * one of its catalogue numbers is in the title, under the same system, and
 * its composer is credited on the Spotify track. Op. numbers count, since the
 * composer has to match as well.
 */
export function confirmWork(
  trackTitle: string,
  artistNames: readonly string[],
  work: {
    workMbid: string;
    title: string;
    composerName: string | null;
    catalogueNumbers: string[];
  },
): ConfirmedWork | null {
  if (!work.composerName) return null;
  const surname = surnameOf(work.composerName);
  if (!surname) return null;
  const credited = artistNames.some((name) =>
    normalizeTitle(name)
      .split(/[^a-z]+/)
      .includes(surname),
  );
  if (!credited) return null;
  const refs = numberRefs(trackTitle);
  for (const number of work.catalogueNumbers) {
    // "op. 27 no. 2" needs both: op. 27 alone is two sonatas.
    const theirs = [...numberRefs(number)];
    const agrees =
      theirs.some(([system]) => system !== 'no') &&
      theirs.every(([system, numbers]) =>
        [...numbers].every((value) => refs.get(system)?.has(value)),
      );
    if (agrees) {
      return {
        workMbid: work.workMbid,
        title: work.title,
        composerName: work.composerName,
        number,
      };
    }
  }
  return null;
}

/**
 * The one part of a confirmed work the track plays, or the work itself.
 *
 * Once catalogue number and composer have fixed the work, the title only has
 * to fix the part, and a language difference ("Konzert für Violine" against
 * "Violin Concerto") no longer matters. A part qualifies when nothing
 * contradicts it and something positive picks it out: the track's movement
 * numeral is the part's position, or the title's "No. 12" is the part's.
 * The work itself qualifies when the track names no movement. Exactly one
 * qualifying candidate is a link; none or several is not.
 */
export function confirmedPart(
  target: ProposalTarget,
  confirmed: ConfirmedWork,
  parts: readonly ProposalCandidate[],
): TrackWorkMatch | null {
  const whole: ProposalCandidate = {
    workMbid: confirmed.workMbid,
    title: confirmed.title,
    parentMbid: null,
    parentTitle: null,
    orderingKey: null,
    composerName: confirmed.composerName,
    aliases: [],
    source: 'album',
  };
  const movement = movementNumber(target.title);
  const qualifying: { candidate: ProposalCandidate; reason: string }[] = [];
  for (const candidate of [
    whole,
    ...parts.filter((part) => part.parentMbid === confirmed.workMbid),
  ]) {
    const signals = candidateSignals(target, candidate);
    if (!signals) continue;
    if (candidate === whole) {
      if (movement === null && parts.every((part) => part.parentMbid !== confirmed.workMbid)) {
        qualifying.push({
          candidate,
          reason: 'The track names no movement, and the work has none.',
        });
      }
      continue;
    }
    if (signals.movementMatch) {
      qualifying.push({
        candidate,
        reason: `The movement number in the track title matches part ${candidate.orderingKey}.`,
      });
      continue;
    }
    const partNo = signals.sharedNumbers.find(
      (number) =>
        number.startsWith('no. ') && numberRefs(candidate.title).get('no')?.has(number.slice(4)),
    );
    if (partNo) qualifying.push({ candidate, reason: `Both titles say ${partNo}.` });
  }
  if (qualifying.length !== 1) return null;
  const [{ candidate, reason }] = qualifying;
  const signals = candidateSignals(target, candidate)!;
  return {
    workMbid: candidate.workMbid,
    title: candidate.title,
    parentTitle: candidate.parentTitle,
    composerName: candidate.composerName ?? confirmed.composerName,
    confidence: 'high',
    source: 'album',
    reasons: [
      `MusicBrainz files ${confirmed.number} by ${confirmed.composerName}, and the track title says ${confirmed.number}.`,
      reason,
      `Composer ${confirmed.composerName} is credited on the track.`,
    ],
    signals: { ...signals, composerMatch: confirmed.composerName },
    linked: true,
    heldBack: null,
  };
}
