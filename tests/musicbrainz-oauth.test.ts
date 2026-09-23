import assert from 'node:assert/strict';
import test from 'node:test';
import { botAuthorizationUrl } from '../app/lib/musicbrainz-oauth';

test('bot authorization requests both submission scopes and an offline refresh token', () => {
  const url = new URL(botAuthorizationUrl('test-client'));
  assert.equal(url.origin, 'https://musicbrainz.org');
  assert.equal(url.pathname, '/oauth2/authorize');
  assert.equal(url.searchParams.get('client_id'), 'test-client');
  assert.equal(url.searchParams.get('scope'), 'submit_isrc submit_barcode');
  assert.equal(url.searchParams.get('access_type'), 'offline');
});
