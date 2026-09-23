import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { InboxSection } from '../app/admin/inbox/InboxSection';

test('Inbox shows an action in progress without changing gap counts', () => {
  const html = renderToStaticMarkup(
    <InboxSection
      inboxClass="barcodes"
      title="Releases with no barcode"
      channel="BOT"
      total={0}
      shown={0}
      pending="Submitting with prelude_fm_bot…"
    />,
  );
  assert.match(html, /role="status"/);
  assert.match(html, /Submitting with prelude_fm_bot…/);
  assert.match(html, /0 to fix/);
});
