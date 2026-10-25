// Reads the PostgreSQL COPY text files inside a MusicBrainz dump (`mbdump/<table>`): one row per
// line, tab-separated, `\N` for null, backslash escapes for tab, newline and backslash.
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const ESCAPES: Record<string, string> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
};

export function unescapeField(raw: string): string | null {
  if (raw === '\\N') return null;
  if (!raw.includes('\\')) return raw;
  return raw.replace(/\\(.)/g, (_, char: string) => ESCAPES[char] ?? char);
}

/** Every field is still escaped: decode only the ones you read, with `field`. */
export async function* rawRows(dir: string, table: string): AsyncGenerator<string[]> {
  const path = join(dir, table);
  if (!existsSync(path)) throw new Error(`${path} is missing: extract mbdump/${table} first`);
  const lines = createInterface({
    input: createReadStream(path, { highWaterMark: 1 << 20 }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line) yield line.split('\t');
  }
}

export const field = (row: string[], index: number): string | null => unescapeField(row[index]);

export function intField(row: string[], index: number): number | null {
  const raw = row[index];
  return raw === '\\N' ? null : Number(raw);
}

/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, as the web service prints partial dates. */
export function partialDate(year: number | null, month: number | null, day: number | null) {
  if (year === null) return null;
  const pad = (value: number) => String(value).padStart(2, '0');
  let date = String(year).padStart(4, '0');
  if (month !== null) {
    date += `-${pad(month)}`;
    if (day !== null) date += `-${pad(day)}`;
  }
  return date;
}
