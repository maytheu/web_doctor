import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2] ?? 'unit';
if (mode !== 'unit' && mode !== 'browser') {
  console.error('Error: expected "unit" or "browser"');
  process.exit(2);
}

const files = (await readdir(path.join(root, 'test')))
  .filter((name) => name.endsWith('.test.mjs') && name.startsWith('browser') === (mode === 'browser'))
  .sort()
  .map((name) => path.join('test', name));

if (files.length === 0) {
  console.error(`Error: no ${mode} test files found in test/`);
  process.exit(2);
}

const args = mode === 'browser' ? ['--test', '--test-concurrency=1', ...files] : ['--test', ...files];
const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
if (result.error) {
  console.error(`Error: failed to start the test runner: ${result.error.message}`);
  process.exit(2);
}
process.exit(result.status ?? 1);
