import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('the package ships with zero dependencies', () => {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.deepEqual(Object.keys(pkg[field] ?? {}), [], `${field} must stay empty`);
  }
});

test('the package requires Node 22 or newer', () => {
  assert.match(pkg.engines?.node ?? '', />=22/);
});
