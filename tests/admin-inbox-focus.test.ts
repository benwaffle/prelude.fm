import assert from 'node:assert/strict';
import test from 'node:test';
import { inboxFocusForAlbum } from '../app/admin/lib/inbox-focus';

test('inboxFocusForAlbum sends absent albums to the missing-release row', () => {
  assert.deepEqual(inboxFocusForAlbum({ id: 'album-1', state: 'absent', mbReleaseId: null }), {
    kind: 'album',
    id: 'album-1',
  });
});

test('inboxFocusForAlbum sends partial releases to the ISRC row', () => {
  assert.deepEqual(
    inboxFocusForAlbum({ id: 'album-1', state: 'partial', mbReleaseId: 'release-1' }),
    { kind: 'release', id: 'release-1' },
  );
});

test('inboxFocusForAlbum sends ambiguous albums to the release picker', () => {
  assert.deepEqual(inboxFocusForAlbum({ id: 'album-1', state: 'ambiguous', mbReleaseId: null }), {
    kind: 'album',
    id: 'album-1',
  });
});
