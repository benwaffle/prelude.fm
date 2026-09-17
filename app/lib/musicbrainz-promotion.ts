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
