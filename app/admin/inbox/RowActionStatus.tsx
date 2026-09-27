import { Notice } from '../components/Notice';
import type { RowActionState } from '../components/useAdminAction';

/**
 * A row's own admin action: waiting its turn, running, or the failure it left.
 * The failure stays until the row is retried or it is dismissed here.
 */
export function RowActionStatus({ row }: { row: RowActionState }) {
  return (
    <>
      {row.status && (
        <span role="status" className="album-meta flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`inline-block h-2.5 w-2.5 rounded-full border-2 border-current ${
              row.status === 'running' ? 'animate-spin border-r-transparent' : 'opacity-50'
            }`}
          />
          {row.status === 'running' ? row.label : `Queued: ${row.label}`}
        </span>
      )}
      {row.failure !== null && (
        <div role="alert">
          <Notice intent="error">
            <div className="flex items-start gap-4">
              <span className="min-w-0 flex-1 whitespace-pre-wrap">{row.failure}</span>
              <button type="button" className="underline" onClick={row.dismiss}>
                Dismiss
              </button>
            </div>
          </Notice>
        </div>
      )}
    </>
  );
}
