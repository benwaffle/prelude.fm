/**
 * Reading a long list of ids without losing its tail.
 *
 * SQLite binds each element of an `IN` list as a parameter and takes about a
 * thousand of them, so any query whose list comes from the data — a
 * composer's works, a library's tracks, an album's ISRCs — has to be read in
 * pieces. Slicing the list to fit is not a guard: it answers the question
 * for part of the input and reports the answer as if it were for all of it.
 */
const PARAMETER_CHUNK = 400;

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
