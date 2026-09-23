export type BotSubmissionFeedback = { kind: 'success' | 'error'; message: string };

export function BotSubmissionNotice({ feedback }: { feedback: BotSubmissionFeedback }) {
  if (feedback.kind === 'success') {
    return (
      <p
        role="status"
        className="rounded border border-green-300 bg-green-50 px-3 py-2 text-green-900"
      >
        {feedback.message}
      </p>
    );
  }

  const status = /MusicBrainz refused the submission: (\d{3})/.exec(feedback.message)?.[1];
  return (
    <div role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-red-800">
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
    </div>
  );
}
