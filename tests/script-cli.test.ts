import assert from 'node:assert/strict';
import test from 'node:test';
import { parseScriptArgs, UsageError } from '../scripts/lib/cli';

const SPEC = {
  json: { type: 'boolean' },
  albums: { type: 'integer', min: 1 },
  top: { type: 'integer', min: 1, default: 10 },
  album: { type: 'string', multiple: true },
  release: { type: 'string' },
} as const;

test('options parse to their types, with defaults', () => {
  const { options, positionals } = parseScriptArgs(
    SPEC,
    ['--json', '--albums', '5', '--album', 'a', '--album', 'b'],
    false,
  );
  assert.deepEqual(options, {
    json: true,
    albums: 5,
    top: 10,
    album: ['a', 'b'],
    release: undefined,
  });
  assert.deepEqual(positionals, []);
});

test('absent options are false, undefined or empty', () => {
  const { options } = parseScriptArgs(SPEC, [], false);
  assert.deepEqual(options, {
    json: false,
    albums: undefined,
    top: 10,
    album: [],
    release: undefined,
  });
});

test('a non-integer is a usage error, not a silent NaN', () => {
  assert.throws(() => parseScriptArgs(SPEC, ['--albums', 'abc'], false), UsageError);
  assert.throws(() => parseScriptArgs(SPEC, ['--albums', '2.5'], false), UsageError);
  assert.throws(() => parseScriptArgs(SPEC, ['--albums', '0'], false), UsageError);
});

test('unknown options, missing values and stray arguments are usage errors', () => {
  assert.throws(() => parseScriptArgs(SPEC, ['--albmus', '5'], false), UsageError);
  assert.throws(() => parseScriptArgs(SPEC, ['--release'], false), UsageError);
  assert.throws(() => parseScriptArgs(SPEC, ['report'], false), UsageError);
  assert.deepEqual(parseScriptArgs(SPEC, ['report'], true).positionals, ['report']);
});
