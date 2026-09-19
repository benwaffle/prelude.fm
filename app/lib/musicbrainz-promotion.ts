/**
 * The rule for letting MusicBrainz fill a field.
 *
 * Kept apart from both the web-service client and the script so the policy can
 * be tested directly: it decides what happens to real catalogue data, and it is
 * the piece most likely to be wrong in a way nothing else would notice.
 */
import { normalizeMetadataText } from '@/lib/classical-normalization';

export type PromotionOutcome =
  /** We hold nothing; MusicBrainz's value can be written. */
  | 'fill'
  /** Both sources agree. Nothing to do, but worth counting as confirmation. */
  | 'agree'
  /** Both hold a value and they differ. Never resolved automatically. */
  | 'conflict';

/**
 * A field we have never filled is a gap; a field we have filled is a claim.
 * Only gaps are writable, so an import can add to the catalogue but can never
 * overwrite it — if the two disagree, one of them is wrong, and discarding ours
 * would also discard the evidence that they ever differed.
 *
 * Whitespace-only values count as empty: a blank movement title is a gap
 * wearing a value's clothes, and treating it as a claim would keep MusicBrainz
 * from filling something that has no content.
 */
export function decidePromotion(
  current: string | null | undefined,
  incoming: string,
  equal: (a: string, b: string) => boolean = textuallyEqual,
): PromotionOutcome {
  if (current == null || current.trim() === '') return 'fill';
  return equal(current, incoming) ? 'agree' : 'conflict';
}

/** Compares display text without being distracted by case, accents or punctuation. */
export function textuallyEqual(a: string, b: string) {
  return normalizeMetadataText(a) === normalizeMetadataText(b);
}

/** Compares a stored year against MusicBrainz's string form. */
export function yearsEqual(a: string, b: string) {
  return a.trim() === b.trim();
}

/**
 * MusicBrainz work types are Capitalised and drawn from a 29-term vocabulary;
 * our `form` column is lower case and considerably more specific ("chorale
 * prelude", "character piece"). Lower-casing is therefore the whole of the
 * conversion — and a difference between the two usually means ours is the
 * better value, not the wrong one.
 */
export function formFromWorkType(workType: string) {
  return workType.toLocaleLowerCase();
}

/**
 * Whether a MusicBrainz artist reached through a work relationship really is
 * the composer we hold.
 *
 * The relationship alone is not enough. A recording of Respighi's Bach
 * transcription performs *Bach's* work, so the composer relationship returns
 * Bach; the "J. C. Bach" viola concerto is a Casadesus forgery that
 * MusicBrainz attributes correctly and we do not. Both produce a unanimous,
 * confident, wrong answer.
 *
 * A name check alone is not enough either. MusicBrainz stores composers under
 * their original script and fullest form — Чайковский, 冼星海, Padre Antonio
 * Soler, Fryderyk rather than Frédéric Chopin — so demanding matching names
 * would discard most of the composers worth having.
 *
 * So: accept when the names agree, or when the life dates do. Those fail
 * together only when the artist is someone else. Sammartini and his brother
 * Giuseppe are five years and one forename apart, and that is the case this is
 * really guarding against.
 */
export function composerMatchIsCredible(
  ourName: string,
  ourBirthYear: number | null,
  mbName: string,
  mbBirthYear: number | null,
  toleranceYears = 2,
): boolean {
  if (textuallyEqual(ourName, mbName)) return true;
  if (ourBirthYear == null || mbBirthYear == null) return false;
  return Math.abs(ourBirthYear - mbBirthYear) <= toleranceYears;
}

/** Numbering MusicBrainz puts in front of a movement title: "III.", "4.", "No. 16". */
const LEADING_NUMBER = /^\s*(?:(?:no\.?\s*)?\d+|[ivxlcdm]+)\s*[.:)]?\s+/i;

/** Catalogue tokens. Their presence means the text names a work, not a movement. */
const CATALOGUE_TOKEN =
  /\b(?:bwv|kv?\.?\s*\d|rv|hwv|hob|buxwv|zwv|twv|wq|woo|d\.\s*\d|op\.?\s*\d|opus)\b/i;

/**
 * Turn a MusicBrainz work title into something that belongs in `work_part_v2.title`.
 *
 * Our model keeps the numbering in `label` and the description in `title`, and
 * renders them together. MusicBrainz keeps one string with the numbering inside
 * it, so storing its value verbatim beside a label we already hold renders
 * "III. III. Alla marcia".
 *
 * MusicBrainz also sometimes names the whole work where we expect a movement —
 * a part labelled "Prelude No. 9" matching a work titled "Prelude and Fugue
 * no. 9 in E major, BWV 854.2/854". Putting that in the title column would
 * claim the movement is called that, which is the kind of plausible-looking
 * wrong value worth less than an honest blank.
 *
 * Returns null when nothing usable survives, and the caller leaves the gap.
 */
export function movementTitleFromMusicBrainz(
  mbTitle: string,
  ourLabel: string | null,
): string | null {
  let text = mbTitle.trim();

  // "Concerto in A minor, op. 3 no. 8, RV 522: III. Allegro" -> "III. Allegro"
  const lastColon = text.lastIndexOf(': ');
  if (lastColon !== -1) text = text.slice(lastColon + 2).trim();

  // Drop numbering we already hold in `label`, then any generic leading numeral.
  if (ourLabel) {
    const label = ourLabel.trim();
    if (text.toLocaleLowerCase().startsWith(label.toLocaleLowerCase())) {
      text = text
        .slice(label.length)
        .replace(/^\s*[.:)]?\s*/, '')
        .trim();
    }
  }
  text = text.replace(LEADING_NUMBER, '').trim();

  // Anything still carrying a catalogue reference is a work title, not a movement.
  if (CATALOGUE_TOKEN.test(text)) return null;
  if (text.length < 2) return null;
  return text;
}

/**
 * A catalogue reference at the end of a title: ", BWV 856.2/856", ", op. 39",
 * ", op. 6 no. 8". The match has to run to the end of the string and contain
 * nothing but the reference, so a nickname after it — Mozart's K. 331 "Alla
 * Turca" — leaves the title alone rather than losing its second half.
 */
const TRAILING_CATALOGUE =
  /,\s*(?:bwv|kv?|rv|hwv|hob|buxwv|zwv|twv|wq|woo|d|s|b|l|cd|fp|sz|bb|op(?:us)?)\.?\s*[\dIVXivx][\w./:-]*(?:\s*(?:no|nr)\.?\s*\d+[a-z]?)?\s*$/i;

/**
 * Turn a MusicBrainz work title into one that fits beside our own.
 *
 * Two differences from their convention. They prefix a work with the
 * collection it belongs to — "The Well-Tempered Clavier, Book I: Prelude and
 * Fugue no. 11 …" — which we express through the catalogue instead. And they
 * put the catalogue reference in the title, where 92% of ours keep it in
 * work_catalog_v2; importing it verbatim would make a tenth of the catalogue
 * read differently from the rest.
 *
 * Returns null when nothing usable survives.
 */
export function workTitleFromMusicBrainz(
  mbTitle: string,
  parentTitle: string | null,
): string | null {
  let text = stripParentPrefixLocal(mbTitle.trim(), parentTitle);
  // Repeat once: "…, BWV 856.2/856" can leave a second reference behind.
  text = text.replace(TRAILING_CATALOGUE, '').trim();
  text = text.replace(TRAILING_CATALOGUE, '').trim();
  text = text.replace(/[\s,:;-]+$/, '').trim();
  if (text.length < 3) return null;
  return text;
}

/** Local copy of the prefix rule, so this module does not depend on the client. */
function stripParentPrefixLocal(leafTitle: string, parentTitle: string | null): string {
  if (!parentTitle) return leafTitle;
  const prefix = `${parentTitle}:`;
  if (!leafTitle.startsWith(prefix)) return leafTitle;
  return leafTitle.slice(prefix.length).trim() || leafTitle;
}

/**
 * Whether MusicBrainz's title says strictly less than ours.
 *
 * "Concerto in G major" against our "Flute Concerto in G major" carries no
 * word we do not already have, and drops the one that says what plays it.
 */
export function saysLessThan(incoming: string, ourTitle: string): boolean {
  const ours = new Set(normalizeMetadataText(ourTitle).split(' ').filter(Boolean));
  const theirs = normalizeMetadataText(incoming).split(' ').filter(Boolean);
  if (theirs.length === 0) return true;
  return theirs.every((token) => ours.has(token));
}

/**
 * Choose new titles for a group of works that currently share one.
 *
 * A title shared by ten works names none of them — the parser had nowhere to
 * record which of Bach's preludes and fugues a work was, so it used the
 * collection for all ten. That is the only case worth overwriting a title for,
 * because everywhere else replacing one title with another is just preferring
 * a different house style.
 *
 * Being different from ours is not enough. The replacement has to do the job
 * ours failed at, so the whole group is decided together and taken only when:
 *
 *  - every proposed title is distinct, since swapping one shared title for
 *    another shared one fixes nothing; and
 *  - no proposal says strictly less than what it replaces, which is what
 *    rules out "Concerto in G major" for "Flute Concerto in G major".
 *
 * A group where any member is missing a proposal is left alone: renaming half
 * of it would leave the catalogue in a worse state than it started.
 */
export function chooseGroupTitles(
  members: { id: number; ourTitle: string; incoming: string | null }[],
): Map<number, string> {
  const empty = new Map<number, string>();
  if (members.length < 2) return empty;
  if (members.some((member) => !member.incoming)) return empty;

  const proposals = members.map((member) => ({ ...member, incoming: member.incoming as string }));

  const distinct = new Set(proposals.map((p) => normalizeMetadataText(p.incoming)));
  if (distinct.size !== proposals.length) return empty;

  if (proposals.some((p) => saysLessThan(p.incoming, p.ourTitle))) return empty;

  const chosen = new Map<number, string>();
  for (const proposal of proposals) {
    if (textuallyEqual(proposal.ourTitle, proposal.incoming)) continue;
    chosen.set(proposal.id, proposal.incoming);
  }
  return chosen;
}
