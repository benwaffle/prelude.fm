import { Notice } from '../components/Notice';

export type BotSubmissionFeedback = {
  kind: 'success' | 'error' | 'empty';
  message: string;
  httpStatus?: number | null;
};

export function BotSubmissionNotice({ feedback }: { feedback: BotSubmissionFeedback }) {
  if (feedback.kind === 'success') {
    return (
      <div role="status">
        <Notice intent="success">{feedback.message}</Notice>
      </div>
    );
  }

  if (feedback.kind === 'empty') {
    return (
      <div role="status">
        <Notice intent="info">{feedback.message}</Notice>
      </div>
    );
  }

  const status = feedback.httpStatus;
  return (
    <div role="alert">
      <Notice intent="error">
        <p>
          {status
            ? `Submission rejected — MusicBrainz returned ${status}.`
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
