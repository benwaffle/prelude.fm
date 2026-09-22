import type { ContributionView } from '../actions/contribute';
import type { InboxClass } from '../lib/admin-url';

export function TriageHeader({
  counts,
  activeClass,
  onClassChange,
}: {
  counts: ContributionView['counts'];
  activeClass?: InboxClass;
  onClassChange?: (inboxClass: InboxClass) => void;
}) {
  const submissions = Object.values(counts.submissions).reduce((sum, count) => sum + count, 0);
  const entries: { inboxClass: InboxClass; label: string; count: string | number }[] = [
    { inboxClass: 'missing', label: 'Missing releases', count: counts.missingReleases },
    { inboxClass: 'misaligned', label: 'Misaligned', count: counts.misaligned },
    {
      inboxClass: 'isrc',
      label: 'ISRCs',
      count: `${counts.isrc} / ${counts.isrcReleases} releases`,
    },
    { inboxClass: 'barcodes', label: 'Barcodes', count: counts.barcodes },
    { inboxClass: 'work', label: 'Work links', count: counts.workRelationships },
    { inboxClass: 'streaming', label: 'Streaming URLs', count: counts.streamingUrls },
    { inboxClass: 'contested', label: 'Contested ISRCs', count: counts.contestedIsrcs },
    { inboxClass: 'submitted', label: 'Submissions', count: submissions },
  ];

  return (
    <nav className="inbox-triage" aria-label="Inbox classes">
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
        </a>
      ))}
    </nav>
  );
}
