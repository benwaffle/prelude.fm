import type { ReadinessFunnel } from '@/lib/catalogue-readiness';
import type { ContributionView } from '../actions/contribute';
import type { InboxClass } from '../lib/admin-url';

type Blocked = { tracks: number; waiting: number };

/** Tracks each Inbox section holds back from the player, from the Overview funnel. */
export function blockedByInboxClass(funnel: ReadinessFunnel): Partial<Record<InboxClass, Blocked>> {
  const blocked: Partial<Record<InboxClass, Blocked>> = {};
  for (const bucket of funnel.steps.flatMap((step) => step.buckets)) {
    if (!bucket.inboxClass) continue;
    const entry = blocked[bucket.inboxClass] ?? { tracks: 0, waiting: 0 };
    entry.tracks += bucket.tracks;
    entry.waiting += bucket.waiting;
    blocked[bucket.inboxClass] = entry;
  }
  return blocked;
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * One number per section, in one unit where it can be: the tracks that
 * section keeps out of the player, the same figure the Overview shows. The
 * sections that keep no track out (ISRCs, barcodes, streaming links) say so
 * and count their own rows instead.
 */
export function TriageHeader({
  counts,
  blocked,
  blockedError,
  activeClass,
  onClassChange,
}: {
  counts: ContributionView['counts'];
  /** Undefined while the funnel loads. */
  blocked?: Partial<Record<InboxClass, Blocked>>;
  blockedError?: string | null;
  activeClass?: InboxClass;
  onClassChange?: (inboxClass: InboxClass) => void;
}) {
  const tracks = (inboxClass: InboxClass) => {
    if (blockedError) return '?';
    if (!blocked) return '…';
    return (blocked[inboxClass]?.tracks ?? 0).toLocaleString();
  };
  const blocking = (inboxClass: InboxClass, label: string, rows: string) => ({
    inboxClass,
    label,
    count: tracks(inboxClass),
    note: `tracks · ${rows}`,
  });
  const awaiting = counts.submissions.pending ?? 0;
  const entries: { inboxClass: InboxClass; label: string; count: string; note: string }[] = [
    blocking('missing', 'Missing releases', plural(counts.missingReleases, 'album')),
    blocking('misaligned', 'Misaligned', plural(counts.misaligned, 'album')),
    blocking('work', 'Work links', plural(counts.workRelationships, 'recording')),
    blocking('contested', 'Contested ISRCs', plural(counts.contestedIsrcs, 'ISRC')),
    {
      inboxClass: 'isrc',
      label: 'ISRCs',
      count: counts.isrc.toLocaleString(),
      note: `on ${plural(counts.isrcReleases, 'release')} · block no track`,
    },
    {
      inboxClass: 'barcodes',
      label: 'Barcodes',
      count: counts.barcodes.toLocaleString(),
      note: 'block no track',
    },
    {
      inboxClass: 'streaming',
      label: 'Streaming URLs',
      count: counts.streamingUrls.toLocaleString(),
      note: 'block no track',
    },
    {
      inboxClass: 'submitted',
      label: 'Submissions',
      count: awaiting.toLocaleString(),
      note: 'awaiting MusicBrainz',
    },
  ];

  return (
    <nav
      className="inbox-triage"
      aria-label="Inbox classes"
      title={blockedError ? `Track counts unavailable: ${blockedError}` : undefined}
    >
      {entries.map((entry) => (
        <a
          key={entry.inboxClass}
          href={`#inbox-${entry.inboxClass}`}
          aria-current={activeClass === entry.inboxClass ? 'location' : undefined}
          onClick={(event) => {
            if (!onClassChange) return;
            event.preventDefault();
            onClassChange(entry.inboxClass);
          }}
        >
          <span className="mono">{entry.count}</span>
          <span>{entry.label}</span>
          <span className="text-[var(--faint)]">{entry.note}</span>
        </a>
      ))}
    </nav>
  );
}
