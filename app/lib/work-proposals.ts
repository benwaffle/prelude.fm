// A proposal is a guess for a person, never a fact: it carries why it guessed so approving is
// reading reasons. Album-family candidates are strongest because the album vouches for them. Pure.

export type ProposalConfidence = 'high' | 'medium' | 'low';

export const CONFIDENCE_ORDER: readonly ProposalConfidence[] = ['high', 'medium', 'low'];

export type ProposalCandidate = {
  workMbid: string;
  title: string;
  parentMbid: string | null;
  parentTitle: string | null;
  orderingKey: number | null;
  composerName: string | null;
  aliases: string[];
  source: 'album' | 'search';
};

export type AlbumSibling = {
  medium: number;
  position: number;
  parentMbid: string;
  orderingKey: number | null;
};

export type ProposalTarget = {
  recordingMbid: string;
  title: string;
  medium: number | null;
  position: number | null;
  artistNames: string[];
  releaseComposers: string[];
  siblings: AlbumSibling[];
};

export type ProposalSignals = {
  titleScore: number;
  sharedNumbers: string[];
  composerMatch: string | null;
  albumSiblings: number;
  orderFits: boolean;
  movementMatch: boolean;
};

export type WorkProposal = {
  workMbid: string;
  title: string;
  parentTitle: string | null;
  composerName: string | null;
  confidence: ProposalConfidence;
  source: ProposalCandidate['source'];
  reasons: string[];
  signals: ProposalSignals;
};

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 };

/** Only plain numerals up to 39 are read. */
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
    // A lone key letter is too weak: only count single-letter systems when a dot or no space
    // separates the number.
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

/** Roman numerals read as numbers so "Suite V" meets "Suite No. 5". */
export function titleTokens(title: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of normalizeTitle(title).split(/[^a-z0-9]+/)) {
    if (!raw || STOPWORDS.has(raw)) continue;
    const roman = raw.length > 1 || raw === 'v' || raw === 'x' ? romanToNumber(raw) : null;
    tokens.add(roman !== null ? String(roman) : raw.replace(/^0+(?=\d)/, ''));
  }
  return tokens;
}

export function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return (2 * shared) / (a.size + b.size);
}

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

/** A movement numeral, or a set member's "No. 2". */
export function partNumber(title: string): number | null {
  const numeral = movementNumber(title);
  if (numeral !== null) return numeral;
  const match = /^no\s*\.?\s*(\d{1,3})\b/.exec(normalizeTitle(lastSection(title)));
  return match ? Number(match[1]) : null;
}

/** The work's own title never carries the movement numeral. */
function withoutMovement(title: string): string {
  const sections = title.split(':');
  const last = sections.pop() ?? '';
  return [...sections, last.trim().replace(MOVEMENT, '')].join(': ');
}

/** With its parent in front where MusicBrainz leaves it off. */
function candidateNames(candidate: ProposalCandidate): string[] {
  const names = [candidate.title, ...candidate.aliases];
  if (candidate.parentTitle && !candidate.title.startsWith(candidate.parentTitle)) {
    names.push(`${candidate.parentTitle}: ${candidate.title}`);
  }
  return names;
}

export function nameWords(name: string): string[] {
  return normalizeTitle(name)
    .split(/[^a-z]+/)
    .filter(Boolean);
}

export function surnameOf(name: string): string | null {
  return nameWords(name).at(-1) ?? null;
}

function composerMatch(target: ProposalTarget, composer: string | null): string | null {
  if (!composer) return null;
  const last = surnameOf(composer);
  if (!last) return null;
  for (const name of [...target.releaseComposers, ...target.artistNames]) {
    if (nameWords(name).includes(last)) return composer;
  }
  return null;
}

function displayRef(system: string, number: string): string {
  return system === 'no' || system === 'op'
    ? `${system}. ${number}`
    : `${system.toUpperCase()} ${number}`;
}

const KEY = /\bin ([a-g])(?: (sharp|flat|b|is|es|s))? (major|minor|dur|moll)\b/;

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

export type ScoredCandidate = {
  candidate: ProposalCandidate;
  signals: ProposalSignals;
  confidence: ProposalConfidence;
};

// Ruled out, not scored low, when a number both titles state disagrees ("No. 3" is not "No. 4") or
// the movement position does.
export function scoreCandidate(
  target: ProposalTarget,
  candidate: ProposalCandidate,
): ScoredCandidate | null {
  const signals = candidateSignals(target, candidate);
  if (!signals) return null;
  const confidence = confidenceOf(candidate, signals);
  return confidence ? { candidate, signals, confidence } : null;
}

export function candidateSignals(
  target: ProposalTarget,
  candidate: ProposalCandidate,
): ProposalSignals | null {
  const names = candidateNames(candidate);
  const targetTokens = titleTokens(withoutMovement(target.title));
  let titleScore = 0;
  // MusicBrainz prefixes a part with its whole lineage where a track title often starts lower down,
  // so each tail is compared.
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

  // The movement itself must be named alike: every suite has an Allemande, but an Ouverture is
  // never one.
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
  // A movement is performed by the movement's own work, never by the whole concerto.
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
      // A part that would land outside the slot the album order leaves belongs to another track or
      // copy.
      if (candidate.orderingKey - target.position !== offset) return null;
      orderFits = true;
    }
  }

  return {
    titleScore: Math.round(titleScore * 100) / 100,
    sharedNumbers,
    composerMatch: composerMatch(target, candidate.composerName),
    albumSiblings: family.length,
    orderFits,
    movementMatch,
  };
}

function confidenceOf(
  candidate: ProposalCandidate,
  signals: ProposalSignals,
): ProposalConfidence | null {
  const { titleScore, composerMatch, sharedNumbers, orderFits, movementMatch, albumSiblings } =
    signals;
  const album = candidate.source === 'album';
  // A part of the very work other tracks perform, in the slot the album leaves for it, needs little
  // help from the title.
  if (albumSiblings > 0 && (orderFits || movementMatch) && titleScore >= 0.35) return 'high';
  // A sibling suite shares its movement names with every other suite, so the title has to say which
  // one.
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

// Possible (a movement split across tracks) but more often one is wrong; the weaker title drops to
// low confidence.
export function flagSharedProposals(
  proposals: readonly { title: string; proposal: WorkProposal | null }[],
): void {
  const byWork = new Map<string, { title: string; proposal: WorkProposal }[]>();
  for (const { title, proposal } of proposals) {
    if (!proposal) continue;
    const list = byWork.get(proposal.workMbid) ?? [];
    list.push({ title, proposal });
    byWork.set(proposal.workMbid, list);
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
