import { inArray, notInArray, type SQLWrapper } from 'drizzle-orm';

/**
 * Film scores are not part of the catalogue, so nothing about them is a
 * contribution we are waiting to make (see `film-scores`).
 */
export function without(column: SQLWrapper, ids: string[]) {
  return ids.length === 0 ? undefined : notInArray(column as never, ids);
}

/**
 * A gap query narrowed to some keys, for a lookup of one row. Undefined
 * reads the whole list; an empty list reads nothing.
 */
export function within(column: SQLWrapper, ids: readonly string[] | undefined) {
  return ids === undefined ? undefined : inArray(column as never, [...ids]);
}
