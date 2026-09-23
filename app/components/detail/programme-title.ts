/**
 * The work heading and numeral column already supply these parts of a
 * MusicBrainz movement title. Keep the source title intact everywhere else.
 */
export function programmeMovementName(
  title: string,
  workTitle: string | null,
  roman: string,
): string {
  let name = title;
  if (workTitle && name.startsWith(`${workTitle}:`)) {
    name = name.slice(workTitle.length + 1).trimStart();
  }

  const numeral = `${roman}.`;
  if (
    roman &&
    (name === numeral || (name.startsWith(numeral) && /^\s/.test(name.slice(numeral.length))))
  ) {
    name = name.slice(numeral.length).trimStart();
  }
  return name;
}
