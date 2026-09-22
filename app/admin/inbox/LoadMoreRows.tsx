import { hasMoreToLoad } from '@/lib/contribution-list';

export function LoadMoreRows({
  shown,
  total,
  busy,
  onMore,
}: {
  shown: number;
  total: number;
  busy: boolean;
  onMore: () => void;
}) {
  if (!hasMoreToLoad(shown, total)) return null;
  return (
    <div className="toolbar">
      <button className="act" disabled={busy} onClick={onMore}>
        Load more
      </button>
    </div>
  );
}
