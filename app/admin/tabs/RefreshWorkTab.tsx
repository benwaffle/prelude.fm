'use client';

import { useState } from 'react';
import { refreshWorkFromMusicBrainz, type RefreshedWork } from '../actions/work-refresh';
import { adminFailureMessage } from '../components/AdminFailure';

/**
 * Pick up an edit made on MusicBrainz without waiting for a sweep: paste a
 * work page link (ours or MusicBrainz's) and the work and its parents are
 * read again.
 */
export function RefreshWorkTab() {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RefreshedWork[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setBusy(true);
    setError(null);
    setResult(null);
    refreshWorkFromMusicBrainz(input)
      .then(setResult)
      .catch((err: unknown) => setError(adminFailureMessage(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="toolbar">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && input.trim() && !busy) refresh();
          }}
          placeholder="Work link or MBID"
          className="min-w-[220px] flex-1"
        />
        <button className="act" onClick={refresh} disabled={busy || !input.trim()}>
          {busy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {error && <p className="text-xs text-[var(--gall)]">{error}</p>}
      {result && (
        <ul className="flex flex-col gap-1 text-xs">
          {result.map((work) => (
            <li key={work.mbid}>
              <a
                href={`https://musicbrainz.org/work/${work.mbid}`}
                target="_blank"
                rel="noreferrer"
              >
                {work.title}
              </a>
              {' · '}
              {work.found ? (work.composer ?? 'no composer') : 'not on MusicBrainz any more'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
