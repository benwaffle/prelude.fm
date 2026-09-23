import { Notice } from '../components/Notice';
import type { BotSubmissionFeedback } from './bot-submission';

export function BotSubmissionNotice({ feedback }: { feedback: BotSubmissionFeedback }) {
  if (feedback.kind !== 'error') {
    return (
      <div role="status">
        <Notice intent={feedback.kind === 'success' ? 'success' : 'info'}>
          {feedback.message}
        </Notice>
      </div>
    );
  }

  return (
    <div role="alert">
      <Notice intent="error">
        <p>
          {feedback.httpStatus
            ? `Submission rejected — MusicBrainz returned ${feedback.httpStatus}.`
            : 'Submission not confirmed.'}
        </p>
        <details className="mt-1">
          <summary className="cursor-pointer underline">Full error details</summary>
          <pre className="mono mt-2 whitespace-pre-wrap break-all text-[11px]">
            {feedback.message}
          </pre>
        </details>
      </Notice>
    </div>
  );
}
