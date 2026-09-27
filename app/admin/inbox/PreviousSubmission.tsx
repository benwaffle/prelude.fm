import type { SubmissionHistoryView } from '../actions/contribute';

/**
 * An earlier attempt that was rejected or withdrawn, shown on a gap that came
 * back so it does not read as a fresh one.
 */
export function PreviousSubmission({ previous }: { previous: SubmissionHistoryView }) {
  return (
    <span className="album-meta">
      {previous.outcome} before (
      {previous.editId ? (
        <a
          href={`https://musicbrainz.org/edit/${previous.editId}`}
          target="_blank"
          rel="noreferrer"
        >
          edit {previous.editId}
        </a>
      ) : (
        <span className="absent">edit ID missing</span>
      )}
      ){previous.explicitOnly && ' · resubmit only from this row'}
    </span>
  );
}
