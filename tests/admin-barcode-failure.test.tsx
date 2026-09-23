import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BotSubmissionNotice } from '../app/admin/inbox/BotSubmissionNotice';

test('barcode rejection is visible at the row and keeps the full MusicBrainz response', () => {
  const error =
    'MusicBrainz refused the submission: 401 <error><text>You are not authorized to access this resource.</text></error>';
  const html = renderToStaticMarkup(
    <BotSubmissionNotice feedback={{ kind: 'error', message: error }} />,
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /Submission rejected — MusicBrainz returned 401/);
  assert.match(html, /<summary[^>]*>Full error details<\/summary>/);
  assert.match(html, /You are not authorized to access this resource/);
});

test('accepted bot edit reports its pending state at the row', () => {
  const html = renderToStaticMarkup(
    <BotSubmissionNotice
      feedback={{ kind: 'success', message: 'Submitted 1 ISRC. Pending MusicBrainz application.' }}
    />,
  );
  assert.match(html, /role="status"/);
  assert.match(html, /Pending MusicBrainz application/);
});
