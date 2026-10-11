import { WorkCredit } from '../work/WorkText';
import type { Programme } from './use-programme';

/**
 * Whose work and which: the composer and title, each labelled when
 * MusicBrainz lacks it. A track we can't place in a work says so.
 */
export function Credit({
  programme,
  linked = false,
  onNavigate,
}: {
  programme: Programme;
  linked?: boolean;
  onNavigate?: () => void;
}) {
  if (!programme.work) return <>Work unmatched</>;
  return (
    <WorkCredit
      work={programme.work}
      href={linked && programme.detailHref ? programme.detailHref : undefined}
      onNavigate={onNavigate}
    />
  );
}
