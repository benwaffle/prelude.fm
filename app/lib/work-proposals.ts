/**
 * Proposing a MusicBrainz work for a recording that has none.
 *
 * A proposal is a guess offered to a person, never a fact: nothing here
 * writes a relationship, and the Inbox only records one after the person has
 * made the edit on MusicBrainz themselves. What this module owes that person
 * is an honest account of why it guessed — which signals agreed, which were
 * missing — so that approving a batch is reading reasons, not re-doing the
 * search.
 *
 * Candidates come from two places. Works in the same family as works other
 * tracks on the album already perform (the other movements of the same
 * sonata, the other suites of the same collection) are the strongest, because
 * the album itself vouches for them. A MusicBrainz work search by title and
 * composer covers albums where nothing is linked yet.
 *
 * Pure: the run that reads MusicBrainz and stores results is in
 * `work-proposals-run.ts`.
 */

export type ProposalConfidence = 'high' | 'medium' | 'low';

export const CONFIDENCE_ORDER: readonly ProposalConfidence[] = ['high', 'medium', 'low'];

export type ProposalCandidate = {
  workMbid: string;
  /** The work's own title, as MusicBrainz has it. */
  title: string;
  parentMbid: string | null;
  parentTitle: string | null;
  /** Position within the parent, from the `parts` relationship. */
  orderingKey: number | null;
  composerName: string | null;
  aliases: string[];
  /**
   * `album` — a part of a work other tracks on this album already perform,
   * or of that work's parent. `search` — a MusicBrainz work search hit.
   */
  source: 'album' | 'search';
};

/** Another track on the same release that already performs a part of a family work. */
export type AlbumSibling = {
  medium: number;
  position: number;
  parentMbid: string;
  orderingKey: number | null;
};

export type ProposalTarget = {
  recordingMbid: string;
  /** The MusicBrainz recording title. */
  title: string;
  /** Where the recording sits on the album's release; null when the release is not cached. */
  medium: number | null;
  position: number | null;
  /** Spotify artists credited on the track; one of them is often the composer. */
  artistNames: string[];
  /** Composers of works other tracks on this release already perform. */
  releaseComposers: string[];
  siblings: AlbumSibling[];
};

export type ProposalSignals = {
  /** 0–1 agreement between the recording title and the work's best-matching name. */
  titleScore: number;
  /** Catalogue and number references found in both titles, e.g. `op. 1`, `no. 5`. */
  sharedNumbers: string[];
  composerMatch: string | null;
  /** Other tracks on the album perform parts of this work's parent. */
  albumSiblings: number;
  /** The track's position matches the part's position by the same offset as its album siblings. */
  orderFits: boolean;
  /** A movement numeral in the track title (`II.`) equals the part's position. */
  movementMatch: boolean;
};

export type WorkProposal = {
  workMbid: string;
  title: string;
  parentTitle: string | null;
  composerName: string | null;
  confidence: ProposalConfidence;
  source: ProposalCandidate['source'];
  /** Plain sentences, strongest first. */
  reasons: string[];
  signals: ProposalSignals;
};

/* --------------------------------------------------------------- titles */

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 };

/** `iv` → 4. Only plain numerals up to 39 are read; anything else is not a numeral here. */
export function romanToNumber(token: string): number | null {
  if (!/^(x{0,3})(ix|iv|v?i{0,3})$/.test(token) || token === '') return null;
  let total = 0;
  for (let index = 0; index < token.length; index++) {
    const value = ROMAN[token[index]];
    const next = ROMAN[token[index + 1]] ?? 0;
    total += value < next ? -value : value;
  }
  return total;
}

export function normalizeTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‐-―–—-]/g, ' ')
    .replace(/[“”„"«»‘’'`]/g, '')
    .replace(/\bn[°º]\s*/g, 'no ')
    .replace(/\bnr\b\.?/g, 'no ')
    .replace(/\bnum\b\.?/g, 'no ')
    .replace(/\bopus\b/g, 'op ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Catalogue systems whose number must agree when both titles carry one. */
const NUMBERED =
  /\b(no|op|bwv|kv|k|hwv|rv|hob|d|zwv|wq|woo|ms|sz|bb|twv|s|l|kk|fwv|wab)\s*\.?\s*([0-9]+[a-z]?)((?:\s*\/\s*[0-9]+)?)/g;

const SET_MEMBER =
  /\b(suite|symphony|symphonie|sinfonia|sonata|sonate|concerto|partita|quartet|quintet|trio|etude|nocturne|ballade|caprice|capriccio|psalm|cantata|ordre)\s+([ivx]+|\d{1,3})\b(?![.)]\s)/g;

/** `op. 1/2` reads as `op 1` plus `no 2`; `kv` is `k`. */
export function numberRefs(title: string): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  const add = (system: string, number: string) => {
    const key = system === 'kv' ? 'k' : system;
    const set = refs.get(key) ?? new Set<string>();
    set.add(number.replace(/^0+(?=\d)/, ''));
    refs.set(key, set);
  };
  const normalized = normalizeTitle(title);
  // "Suite V", "Symphony 5": a numbered member of a set, the same as "No. 5".
  for (const match of normalized.matchAll(SET_MEMBER)) {
    const number = /^\d+$/.test(match[2]) ? Number(match[2]) : romanToNumber(match[2]);
    if (number !== null) add('no', String(number));
  }
  for (const match of normalized.matchAll(NUMBERED)) {
    // A lone key letter ("in D 5"?) is too weak to read as a catalogue: only
    // count single-letter systems when a dot or no space separates the number.
    if (match[1].length === 1 && !/^[a-z]\s*\.|^[a-z][0-9]/.test(match[0])) continue;
    add(match[1], match[2]);
    const sub = match[3]?.replace(/[\s/]/g, '');
    if (sub) add('no', sub);
  }
  return refs;
}

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'the',
  'of',
  'for',
  'in',
  'on',
  'from',
  'de',
  'du',
  'des',
  'la',
  'le',
  'les',
  'el',
  'il',
  'di',
  'del',
  'und',
  'der',
  'die',
  'das',
  'fur',
  'en',
  'et',
  'with',
  'op',
  'no',
]);

/** Content words, with roman numerals read as numbers so "Suite V" meets "Suite No. 5". */
export function titleTokens(title: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of normalizeTitle(title).split(/[^a-z0-9]+/)) {
    if (!raw || STOPWORDS.has(raw)) continue;
    const roman = raw.length > 1 || raw === 'v' || raw === 'x' ? romanToNumber(raw) : null;
    tokens.add(roman !== null ? String(roman) : raw.replace(/^0+(?=\d)/, ''));
  }
  return tokens;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/**
 * The movement numeral a track title puts in front of its last section:
 * "Suite V in D minor: II. Allemande" → 2.
 */
const MOVEMENT = /^([ivxIVX]+|\d{1,2})[.)]\s/;

export function movementNumber(title: string): number | null {
  const last = title.split(':').pop()?.trim() ?? '';
  const match = MOVEMENT.exec(last);
  if (!match) return null;
  return /^\d+$/.test(match[1]) ? Number(match[1]) : romanToNumber(match[1].toLowerCase());
}

function lastSection(title: string): string {
  return title.split(':').pop()?.trim() ?? '';
}

/**
 * A work's place in its parent as its own title states it: a movement
 * numeral, or a set member's "No. 2" ("3 polkas poétiques, op. 8: No. 2 in G minor").
 */
export function partNumber(title: string): number | null {
  const numeral = movementNumber(title);
  if (numeral !== null) return numeral;
  const match = /^no\s*\.?\s*(\d{1,3})\b/.exec(normalizeTitle(lastSection(title)));
  return match ? Number(match[1]) : null;
}

/** The title without its movement numeral, which the work's own title never carries. */
function withoutMovement(title: string): string {
  const sections = title.split(':');
  const last = sections.pop() ?? '';
  return [...sections, last.trim().replace(MOVEMENT, '')].join(': ');
}

/** Every name the candidate goes by, with its parent in front where MusicBrainz leaves it off. */
function candidateNames(candidate: ProposalCandidate): string[] {
  const names = [candidate.title, ...candidate.aliases];
  if (candidate.parentTitle && !candidate.title.startsWith(candidate.parentTitle)) {
    names.push(`${candidate.parentTitle}: ${candidate.title}`);
  }
  return names;
}

function surname(name: string): string {
  const words = normalizeTitle(name)
    .split(/[^a-z]+/)
    .filter(Boolean);
  return words[words.length - 1] ?? '';
}

function composerMatch(target: ProposalTarget, composer: string | null): string | null {
  if (!composer) return null;
  const last = surname(composer);
  if (!last) return null;
  for (const name of [...target.releaseComposers, ...target.artistNames]) {
    const words = normalizeTitle(name).split(/[^a-z]+/);
    if (words.includes(last)) return composer;
  }
  return null;
}

function displayRef(system: string, number: string): string {
  return system === 'no' || system === 'op'
    ? `${system}. ${number}`
    : `${system.toUpperCase()} ${number}`;
}

const KEY = /\bin ([a-g])(?: (sharp|flat|b|is|es|s))? (major|minor|dur|moll)\b/;

/** "in B-flat major", "in Bb major", "in b-moll" → `b flat major`; null when the title names no key. */
export function keyOf(title: string): string | null {
  const match = KEY.exec(normalizeTitle(title).replace(/\bin ([a-g])b\b/, 'in $1 flat'));
  if (!match) return null;
  const accidental =
    match[2] === 'sharp' || match[2] === 'is'
      ? ' sharp'
      : match[2] === 'flat' || match[2] === 'b' || match[2] === 'es' || match[2] === 's'
        ? ' flat'
        : '';
  const mode = match[3] === 'major' || match[3] === 'dur' ? 'major' : 'minor';
  return `${match[1]}${accidental} ${mode}`;
}

/* -------------------------------------------------------------- scoring */

export type ScoredCandidate = {
  candidate: ProposalCandidate;
  signals: ProposalSignals;
  confidence: ProposalConfidence;
};

/**
 * Score one candidate, or rule it out.
 *
 * A candidate is ruled out, not merely scored low, when the titles disagree
 * on a number both of them state — "No. 3" is not "No. 4" however similar the
 * rest reads — or when the track's movement numeral and the part's position
 * disagree.
 */
export function scoreCandidate(
  target: ProposalTarget,
  candidate: ProposalCandidate,
): ScoredCandidate | null {
  const names = candidateNames(candidate);
  const targetTokens = titleTokens(withoutMovement(target.title));
  let titleScore = 0;
  // MusicBrainz prefixes a part with its whole lineage ("24 Caprices, op. 1:
  // No. 1 in E major: Andante") where a track title often starts lower down,
  // so each tail of the lineage is compared as well as the whole.
  for (const name of names) {
    const sections = name.split(':');
    for (let start = 0; start < sections.length; start++) {
      const tail = titleTokens(sections.slice(start).join(':'));
      titleScore = Math.max(titleScore, dice(targetTokens, tail));
    }
  }

  const targetRefs = numberRefs(target.title);
  const candidateRefs = new Map<string, Set<string>>();
  for (const name of names) {
    for (const [system, numbers] of numberRefs(name)) {
      const set = candidateRefs.get(system) ?? new Set<string>();
      for (const number of numbers) set.add(number);
      candidateRefs.set(system, set);
    }
  }
  const sharedNumbers: string[] = [];
  for (const [system, numbers] of targetRefs) {
    const theirs = candidateRefs.get(system);
    if (!theirs) continue;
    const shared = [...numbers].filter((number) => theirs.has(number));
    if (shared.length === 0) return null;
    for (const number of shared) sharedNumbers.push(displayRef(system, number));
  }

  const targetKey = keyOf(target.title);
  if (targetKey) {
    const keys = names.map(keyOf).filter((key): key is string => key !== null);
    if (keys.length > 0 && !keys.includes(targetKey)) return null;
  }

  // The movement itself must be named alike: every suite has an Allemande,
  // but an Ouverture is never one.
  const targetLeaf = titleTokens(lastSection(withoutMovement(target.title)));
  const candidateLeaf = titleTokens(lastSection(withoutMovement(candidate.title)));
  if (targetLeaf.size > 0 && candidateLeaf.size > 0 && dice(targetLeaf, candidateLeaf) === 0) {
    return null;
  }

  const movement = movementNumber(target.title);
  const part = candidate.orderingKey ?? partNumber(candidate.title);
  let movementMatch = false;
  if (movement !== null && part !== null) {
    if (movement !== part) return null;
    movementMatch = true;
  }
  // A movement is performed by the movement's own work, never by the whole
  // concerto it belongs to.
  if (movement !== null && part === null && !candidate.title.includes(':')) return null;

  const family = target.siblings.filter((sibling) => sibling.parentMbid === candidate.parentMbid);
  let orderFits = false;
  if (
    family.length > 0 &&
    candidate.orderingKey !== null &&
    target.position !== null &&
    target.medium !== null
  ) {
    const offsets = new Set(
      family
        .filter((sibling) => sibling.medium === target.medium && sibling.orderingKey !== null)
        .map((sibling) => (sibling.orderingKey as number) - sibling.position),
    );
    if (offsets.size === 1) {
      const [offset] = offsets;
      // The album already shows where this work's parts sit; a part that
      // would land anywhere else belongs to another track or another copy.
      if (candidate.orderingKey - target.position !== offset) return null;
      orderFits = true;
    }
  }

  const signals: ProposalSignals = {
    titleScore: Math.round(titleScore * 100) / 100,
    sharedNumbers,
    composerMatch: composerMatch(target, candidate.composerName),
    albumSiblings: family.length,
    orderFits,
    movementMatch,
  };
  const confidence = confidenceOf(candidate, signals);
  return confidence ? { candidate, signals, confidence } : null;
}

function confidenceOf(
  candidate: ProposalCandidate,
  signals: ProposalSignals,
): ProposalConfidence | null {
  const { titleScore, composerMatch, sharedNumbers, orderFits, movementMatch, albumSiblings } =
    signals;
  const album = candidate.source === 'album';
  // A part of the very work other tracks perform, in the slot the album
  // order leaves for it, needs little help from the title.
  if (albumSiblings > 0 && (orderFits || movementMatch) && titleScore >= 0.35) return 'high';
  // A part of a sibling work in the same collection (another suite of the
  // set) shares its movement names with every other suite, so the title has
  // to say which one.
  if (album && movementMatch && titleScore >= 0.7) return 'high';
  if (album && titleScore >= 0.8) return 'high';
  if (titleScore >= 0.85 && composerMatch && sharedNumbers.length > 0) return 'high';
  if (album && titleScore >= 0.5) return 'medium';
  if (titleScore >= 0.65 && composerMatch) return 'medium';
  if (titleScore >= 0.55 && (composerMatch || album)) return 'low';
  return null;
}

function rank(scored: ScoredCandidate): number {
  return (
    (3 - CONFIDENCE_ORDER.indexOf(scored.confidence)) * 10 +
    scored.signals.titleScore +
    (scored.signals.orderFits ? 0.5 : 0) +
    (scored.signals.movementMatch ? 0.3 : 0) +
    (scored.signals.composerMatch ? 0.2 : 0) +
    scored.signals.sharedNumbers.length * 0.1
  );
}

function lower(confidence: ProposalConfidence): ProposalConfidence {
  return confidence === 'high' ? 'medium' : 'low';
}

function reasonsFor(scored: ScoredCandidate): string[] {
  const { candidate, signals } = scored;
  const reasons: string[] = [];
  if (signals.albumSiblings > 0) {
    reasons.push(
      `${signals.albumSiblings} other track${signals.albumSiblings === 1 ? '' : 's'} on this album already perform${signals.albumSiblings === 1 ? 's' : ''} parts of ${candidate.parentTitle ?? 'the same work'}.`,
    );
  } else if (candidate.source === 'album') {
    reasons.push(`Part of the same collection as works other tracks on this album perform.`);
  } else {
    reasons.push('Found by a MusicBrainz work search on the title and composer.');
  }
  if (signals.orderFits) reasons.push('Its position in the work matches the track order.');
  if (signals.movementMatch) {
    reasons.push(`The movement number in the track title matches part ${candidate.orderingKey}.`);
  }
  if (signals.sharedNumbers.length > 0) {
    reasons.push(`Both titles say ${signals.sharedNumbers.join(', ')}.`);
  }
  reasons.push(
    signals.titleScore >= 0.8
      ? 'The titles agree closely.'
      : signals.titleScore >= 0.5
        ? 'The titles partly agree.'
        : 'The titles share only a few words.',
  );
  if (signals.composerMatch) {
    reasons.push(`Composer ${signals.composerMatch} is credited on the album.`);
  } else if (candidate.composerName) {
    reasons.push(`Composer ${candidate.composerName} is not credited on the album.`);
  } else {
    reasons.push('MusicBrainz has no composer on this work.');
  }
  return reasons;
}

/** The best candidate for one recording, or null when nothing clears the bar. */
export function proposeWork(
  target: ProposalTarget,
  candidates: readonly ProposalCandidate[],
): WorkProposal | null {
  const seen = new Set<string>();
  const scored: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.workMbid)) continue;
    seen.add(candidate.workMbid);
    const result = scoreCandidate(target, candidate);
    if (result) scored.push(result);
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => rank(b) - rank(a));
  const [best, runnerUp] = scored;
  let confidence = best.confidence;
  const reasons = reasonsFor(best);
  if (
    runnerUp &&
    runnerUp.confidence === best.confidence &&
    Math.abs(runnerUp.signals.titleScore - best.signals.titleScore) < 0.05 &&
    runnerUp.signals.orderFits === best.signals.orderFits
  ) {
    confidence = confidence === 'low' ? 'low' : lower(confidence);
    reasons.push(`Another work, “${runnerUp.candidate.title}”, fits about as well.`);
  }
  return {
    workMbid: best.candidate.workMbid,
    title: best.candidate.title,
    parentTitle: best.candidate.parentTitle,
    composerName: best.candidate.composerName,
    confidence,
    source: best.candidate.source,
    reasons,
    signals: best.signals,
  };
}

/**
 * Two tracks of one album proposed the same work: possible (a movement split
 * across tracks), but more often one of them is wrong. The weaker title keeps
 * its proposal at low confidence, saying why.
 */
export function flagSharedProposals(
  proposals: readonly { recordingMbid: string; title: string; proposal: WorkProposal | null }[],
): void {
  const byWork = new Map<
    string,
    { recordingMbid: string; title: string; proposal: WorkProposal }[]
  >();
  for (const row of proposals) {
    if (!row.proposal) continue;
    const list = byWork.get(row.proposal.workMbid) ?? [];
    list.push(row as { recordingMbid: string; title: string; proposal: WorkProposal });
    byWork.set(row.proposal.workMbid, list);
  }
  for (const rows of byWork.values()) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => b.proposal.signals.titleScore - a.proposal.signals.titleScore);
    for (const row of rows.slice(1)) {
      row.proposal.confidence = 'low';
      row.proposal.reasons.push(`The same work is also proposed for “${rows[0].title}”.`);
    }
  }
}
