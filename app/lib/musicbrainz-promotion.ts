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
