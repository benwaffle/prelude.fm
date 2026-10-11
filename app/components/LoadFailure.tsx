/**
 * A load that failed, shown where its data would have been — never as an
 * empty list, which would read as "there is nothing here".
 *
 * The listening screens' look by default; the admin passes its notice style.
 */
export function LoadFailure({
  what,
  error,
  onRetry,
  className = 'font-display text-[15px] text-accent italic',
}: {
  what: string;
  error: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={className}>
      <div className="flex items-start gap-4">
        <span className="min-w-0 flex-1 whitespace-pre-wrap">
          Could not load {what}: {error}
        </span>
        {onRetry && (
          <button type="button" className="cursor-pointer underline" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
