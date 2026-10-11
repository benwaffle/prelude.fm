import assert from 'node:assert/strict';
import test from 'node:test';
import { adminHref, parseAdminUrl } from '../app/admin/lib/admin-url';

test('admin URL state validates pages, filters, and focus', () => {
  assert.deepEqual(
    parseAdminUrl(
      new URLSearchParams('page=albums&album=spotify-album&release=ignored&filter=absent'),
    ),
    {
      page: 'albums',
      focus: { kind: 'album', id: 'spotify-album' },
      albumFilter: 'absent',
    },
  );
});

test('admin URL state ignores unknown values', () => {
  assert.deepEqual(parseAdminUrl(new URLSearchParams('page=nope&filter=nope&album=%20')), {
    page: null,
    focus: null,
    albumFilter: undefined,
  });
  assert.equal(parseAdminUrl(new URLSearchParams('page=toString')).page, null);
});

test('links from the old tabs land on the page that holds what they pointed at', () => {
  const pageOf = (query: string) => parseAdminUrl(new URLSearchParams(query)).page;
  assert.equal(pageOf('tab=inbox&class=missing&album=a'), 'missing');
  assert.equal(pageOf('tab=inbox'), null);
  assert.equal(pageOf('tab=overview'), null);
  assert.equal(pageOf('tab=albums'), 'albums');
  assert.equal(pageOf('tab=health'), 'checks');
  assert.equal(pageOf('tab=details'), null);
  assert.equal(pageOf('tab=details&filter=unchecked'), 'albums');
});

test('admin hrefs carry the page, focus, and album filter', () => {
  assert.equal(adminHref(null), '/admin');
  assert.equal(
    adminHref('isrc', { focus: { kind: 'release', id: 'r 1' } }),
    '/admin?page=isrc&release=r+1',
  );
  assert.equal(adminHref('albums', { albumFilter: 'absent' }), '/admin?page=albums&filter=absent');
});
