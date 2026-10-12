import { WorkCredit } from '../work/WorkText';
import type { Programme } from './use-programme';

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
