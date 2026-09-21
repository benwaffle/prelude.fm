import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildIsrcSubmission,
  editCount,
  isWellFormedIsrc,
} from '../app/lib/musicbrainz-isrc-submission';

test('a well-formed ISRC is two letters, three alphanumerics and seven digits', () => {
  assert.equal(isWellFormedIsrc('GBAYE0601498'), true);
  assert.equal(isWellFormedIsrc('FRZ131321010'), true);
  assert.equal(isWellFormedIsrc('TOO-SHORT'), false);
  assert.equal(isWellFormedIsrc('GBAYE060149'), false);
  assert.equal(isWellFormedIsrc(''), false);
});

test('the payload nests every ISRC under its recording', () => {
  const xml = buildIsrcSubmission([
    { recordingMbid: 'rec-1', isrc: 'GBAYE0601498' },
    { recordingMbid: 'rec-1', isrc: 'GBAYE0601499' },
    { recordingMbid: 'rec-2', isrc: 'FRZ131321010' },
  ]);
  assert.match(xml, /<metadata xmlns="http:\/\/musicbrainz\.org\/ns\/mmd-2\.0#">/);
  assert.match(xml, /<recording id="rec-1">[\s\S]*<isrc-list count="2">/);
  assert.match(xml, /<isrc id="GBAYE0601498" \/>/);
  assert.match(xml, /<recording id="rec-2">[\s\S]*<isrc-list count="1">/);
});

test('a malformed ISRC never reaches the payload', () => {
  // MusicBrainz would reject the whole document; worse, a typo submitted to
  // somebody else's database is somebody else's problem to undo.
  const xml = buildIsrcSubmission([
    { recordingMbid: 'rec-1', isrc: 'not-an-isrc' },
    { recordingMbid: 'rec-1', isrc: 'GBAYE0601498' },
  ]);
  assert.doesNotMatch(xml, /not-an-isrc/);
  assert.match(xml, /<isrc-list count="1">/);
});

test('an ISRC is normalised to upper case', () => {
  const xml = buildIsrcSubmission([{ recordingMbid: 'rec-1', isrc: 'gbaye0601498' }]);
  assert.match(xml, /<isrc id="GBAYE0601498" \/>/);
});

test('the same ISRC twice on one recording is one edit, not two', () => {
  const items = [
    { recordingMbid: 'rec-1', isrc: 'GBAYE0601498' },
    { recordingMbid: 'rec-1', isrc: 'GBAYE0601498' },
  ];
  assert.equal(editCount(items), 1);
  assert.match(buildIsrcSubmission(items), /<isrc-list count="1">/);
});

test('the cap counts edits rather than requests', () => {
  // One POST can carry fifty ISRCs. The bot code of conduct caps edits at
  // 1,000 a day, so counting requests would let one request spend fifty
  // times its share.
  const items = Array.from({ length: 50 }, (_, i) => ({
    recordingMbid: `rec-${i}`,
    isrc: `GBAYE06014${String(i).padStart(2, '0')}`,
  }));
  assert.equal(editCount(items), 50);
});

test('an id containing XML syntax cannot break out of the document', () => {
  const xml = buildIsrcSubmission([
    { recordingMbid: 'rec"><evil/><recording id="x', isrc: 'GBAYE0601498' },
  ]);
  assert.doesNotMatch(xml, /<evil\/>/);
  assert.match(xml, /&quot;&gt;&lt;evil\/&gt;/);
});

test('the edit note travels inside the document', () => {
  // The server reads it with the XPath /mb:metadata/mb:edit-note. The first
  // version of this built a note, stored it in our ledger, and submitted
  // four edits without one — which the bot code of conduct requires.
  const xml = buildIsrcSubmission(
    [{ recordingMbid: 'rec-1', isrc: 'GBAYE0601498' }],
    'Because of reasons.',
  );
  assert.match(xml, /<edit-note>Because of reasons\.<\/edit-note>/);
  assert.match(xml, /<\/recording-list>[\s\S]*<edit-note>/);
});

test('a note containing XML syntax cannot break the document', () => {
  const xml = buildIsrcSubmission(
    [{ recordingMbid: 'rec-1', isrc: 'GBAYE0601498' }],
    'see <this> & "that"',
  );
  assert.match(xml, /see &lt;this&gt; &amp; &quot;that&quot;/);
  assert.doesNotMatch(xml, /<this>/);
});

test('no note means no element rather than an empty one', () => {
  const xml = buildIsrcSubmission([{ recordingMbid: 'rec-1', isrc: 'GBAYE0601498' }]);
  assert.doesNotMatch(xml, /edit-note/);
});
