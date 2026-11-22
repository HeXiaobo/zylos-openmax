import test from 'node:test';
import assert from 'node:assert/strict';
import { readCoreVersion, compareCoreVersions, coreServesObjectApis, OBJECT_API_MIN_CORE_VERSION } from './core-version.js';

// In-memory installation observations only: no CLI, processes or host files.
function fixture() {
  const files = new Map(), commands = new Map();
  const env = { HOME: '/isolated/home', PATH: '/isolated/bin' };
  const record = '/isolated/home/zylos/.claude/skills/comm-bridge/.zylos/core-package.json';
  const io = {
    readFileSync(file) { if (!files.has(file)) throw new Error('missing'); return files.get(file); },
    statSync(file) { if (!commands.has(file)) throw new Error('missing'); return { isFile: () => true }; },
    accessSync(file) { if (!commands.has(file)) throw new Error('missing'); },
    realpathSync(file) { return commands.get(file); },
  };
  const pkg = (root, version) => files.set(`${root}/package.json`, JSON.stringify({ name: 'zylos', version }));
  return { env, io, record, files, commands, pkg, read: () => readCoreVersion({ env, io }) };
}

for (const version of ['0.9.9', '1.0.0-beta.8', '1.1.0']) {
  test(`installed Core ${version} is read from its installation record`, () => {
    const f = fixture();
    f.files.set(f.record, JSON.stringify({ v: 1, packageRoot: '/isolated/core' }));
    f.pkg('/isolated/core', version);
    assert.equal(f.read(), version);
  });
}

test('older installations resolve the executable package on PATH without running it', () => {
  const f = fixture();
  f.commands.set('/isolated/bin/zylos', '/isolated/core/cli/zylos.js');
  f.pkg('/isolated/core', '0.9.8');
  assert.equal(f.read(), '0.9.8');
});

test('existing explicit Core override wins, and an unreadable override stays unknown', () => {
  const f = fixture();
  f.env.ZYLOS_PACKAGE_ROOT = '/isolated/explicit';
  f.commands.set('/isolated/bin/zylos', '/isolated/core/cli/zylos.js');
  f.pkg('/isolated/core', '0.9.8');
  assert.equal(f.read(), null);
  f.pkg('/isolated/explicit', '1.0.0-beta.8');
  assert.equal(f.read(), '1.0.0-beta.8');
});

test('a stale installation record falls back to PATH and unknown packages remain unknown', () => {
  const f = fixture();
  f.files.set(f.record, JSON.stringify({ v: 1, packageRoot: '/isolated/removed' }));
  f.commands.set('/isolated/bin/zylos', '/isolated/core/cli/zylos.js');
  assert.equal(f.read(), null);
  f.pkg('/isolated/core', '1.0.0');
  assert.equal(f.read(), '1.0.0');
  f.files.set('/isolated/core/package.json', JSON.stringify({ name: 'another-package', version: '0.9.8' }));
  assert.equal(f.read(), null);
});

test('the object APIs start at Core 1.0.0-beta.12', () => {
  assert.equal(OBJECT_API_MIN_CORE_VERSION, '1.0.0-beta.12');
});

// Semver precedence, pre-release part included: numeric identifiers compare
// as numbers (beta.2 < beta.12, which a text comparison gets wrong).
for (const [a, b, expected] of [
  ['1.0.0-beta.2', '1.0.0-beta.12', -1],
  ['1.0.0-beta.11', '1.0.0-beta.12', -1],
  ['1.0.0-beta.12', '1.0.0-beta.12', 0],
  ['1.0.0-beta.13', '1.0.0-beta.12', 1],
  ['1.0.0', '1.0.0-beta.12', 1],
  ['1.0.0-rc.1', '1.0.0-beta.12', 1],
  ['1.0.0-alpha.20', '1.0.0-beta.12', -1],
  ['1.0.0-beta', '1.0.0-beta.12', -1],
  ['1.0.0-beta.12.1', '1.0.0-beta.12', 1],
  ['1.0.0-beta.x', '1.0.0-beta.12', 1],
  ['1.0.0-beta.-', '1.0.0-beta.12', 1],
  ['1.0.0-beta.12+build.5', '1.0.0-beta.12', 0],
  ['0.9.9', '1.0.0-beta.12', -1],
  ['1.10.0', '1.9.0', 1],
  ['1.0.0-beta.100000000000000000001', '1.0.0-beta.100000000000000000000', 1],
]) {
  test(`${a} compares ${expected} against ${b}`, () => {
    assert.equal(compareCoreVersions(a, b), expected);
    assert.equal(compareCoreVersions(b, a), -expected || 0);
  });
}

for (const value of [null, undefined, '', '1.0', 'v1.0.0', '1.0.0-', '1.0.0-beta..1', 'not-a-version']) {
  test(`an unparsable version ${JSON.stringify(value)} compares as null and selects the earlier sources`, () => {
    assert.equal(compareCoreVersions(value, '1.0.0'), null);
    assert.equal(coreServesObjectApis(value), false);
  });
}

for (const [version, expected] of [
  ['0.9.9', false], ['1.0.0-beta.1', false], ['1.0.0-beta.2', false], ['1.0.0-beta.11', false],
  ['1.0.0-beta.12', true], ['1.0.0-beta.13', true], ['1.0.0', true], ['1.3.0', true], ['2.0.0-alpha.1', true],
]) {
  test(`Core ${version} ${expected ? 'serves' : 'does not serve'} the object APIs`, () => {
    assert.equal(coreServesObjectApis(version), expected);
  });
}
