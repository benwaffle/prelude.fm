import { sql, type SQL } from 'drizzle-orm';

/**
 * Reading a long list of ids without losing its tail.
 *
 * SQLite binds each element of an `IN` list as a parameter and caps how many
 * a statement takes, so any query whose list comes from the data — a
 * composer's works, a library's tracks, an album's ISRCs — has to be read in
 * pieces. Slicing the list to fit is not a guard: it answers the question
 * for part of the input and reports the answer as if it were for all of it.
 *
 * Turso's libSQL takes 32,766 parameters per statement (checked against prod
 * 2026-10-11: 32,766 bind, 40,000 are refused). Each chunk is a round trip,
 * so a chunk is sized to read a whole library at once while leaving room for
 * a query that binds its chunk up to three times.
 */
const PARAMETER_CHUNK = 10_000;

export async function forChunks<Input, Row>(
  values: Iterable<Input>,
  read: (chunk: Input[]) => Promise<Row[]>,
): Promise<Row[]> {
  const unique = [...new Set(values)];
  const rows: Row[] = [];
  for (let start = 0; start < unique.length; start += PARAMETER_CHUNK) {
    rows.push(...(await read(unique.slice(start, start + PARAMETER_CHUNK))));
  }
  return rows;
}

/**
 * A list of any length as a one-column subquery: the whole list binds as a
 * single JSON parameter, so it needs no chunking. `col in (${jsonList(ids)})`
 * still uses the column's index.
 */
export function jsonList(values: Iterable<string>): SQL {
  return sql`select value from json_each(${JSON.stringify([...new Set(values)])})`;
}

/** Items in runs of `size`, for statements whose size grows with the list (multi-row inserts). */
export function chunksOf<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    out.push(items.slice(start, start + size));
  return out;
}
