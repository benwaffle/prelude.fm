import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAdminUrl, patchAdminUrl } from '../app/admin/lib/admin-url';

test('admin URL state validates tabs, classes, filters, and focus', () => {
  assert.deepEqual(
    parseAdminUrl(
      new URLSearchParams(
        'tab=albums&class=missing&album=spotify-album&release=ignored&filter=absent',
      ),
    ),
    {
      tab: 'details',
      inboxClass: 'missing',
      focus: { kind: 'album', id: 'spotify-album' },
      albumFilter: 'absent',
    },
  );
});

test('admin URL state ignores unknown values', () => {
  assert.deepEqual(
    parseAdminUrl(new URLSearchParams('tab=nope&class=nope&filter=nope&album=%20')),
    {
      tab: 'overview',
      inboxClass: undefined,
      focus: null,
      albumFilter: undefined,
    },
  );
});

test('the old Albums and Health tabs open Details', () => {
  assert.equal(parseAdminUrl(new URLSearchParams('tab=albums')).tab, 'details');
  assert.equal(parseAdminUrl(new URLSearchParams('tab=health')).tab, 'details');
  assert.equal(parseAdminUrl(new URLSearchParams('tab=inbox')).tab, 'inbox');
  assert.equal(parseAdminUrl(new URLSearchParams('tab=toString')).tab, 'overview');
});

test('admin URL patches preserve unrelated state and remove null values', () => {
  assert.equal(
    patchAdminUrl(new URLSearchParams('tab=albums&filter=absent'), {
      tab: 'inbox',
      filter: null,
      class: 'missing',
      album: 'album-id',
    }),
    '?tab=inbox&class=missing&album=album-id',
  );
});
