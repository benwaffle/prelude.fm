import { sql, type SQL } from 'drizzle-orm';

// SQLite caps bound parameters per statement, and truncating the list would silently answer for
// part of the input. Turso takes 32,766 (checked 2026-10-11); 10k leaves room for a query binding
// its chunk three times.
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

// The whole list binds as one JSON parameter, so it needs no chunking, and `col in (...)` still
// uses the index.
export function jsonList(values: Iterable<string>): SQL {
  return sql`select value from json_each(${JSON.stringify([...new Set(values)])})`;
}

export function chunksOf<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    out.push(items.slice(start, start + size));
  return out;
}
