// Guard against the class of bug that took the preset offline twice: a new
// module in src/host/ that the package build never copies, so the published
// lib/ imports a file that does not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { HOST_PAIRS } from '../../scripts/build-lib.mjs';

const hostSources = readdirSync(new URL('../', import.meta.url))
  .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))
  .sort();

test('every src/host module is copied into the package', () => {
  const covered = new Set(HOST_PAIRS.map(([source]) => source.replace('src/host/', '')));
  const missing = hostSources.filter((name) => !covered.has(name));
  assert.deepEqual(missing, [], `build-lib.mjs would ship a package without: ${missing.join(', ')}`);
});

test('host modules keep the layout their relative imports expect', () => {
  for (const [source, target] of HOST_PAIRS) {
    assert.match(target, /^lib\/([a-z-]+\.js|host\/[a-z-]+\.js)$/, `${source} → ${target}`);
  }
});
