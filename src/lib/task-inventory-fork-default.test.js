import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// 3ai fork patch guard. Upstream turns the scheduled-task inventory on unless
// `taskInventory.enabled: false`. The payload is the machine's whole user
// crontab, redacted by a heuristic with documented gaps, so this fork makes it
// opt-in. These assertions fail if a future upstream merge (or an edit) quietly
// restores the upstream default — which is exactly how the patch would be lost.

const ROOT = path.resolve(import.meta.dirname, '..', '..');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('fork: scheduled-task inventory is off unless enabled: true', () => {
  const bridge = read('src/comm-bridge.js');

  // The gate is an explicit opt-in and it is the only gate for the task.
  assert.match(
    bridge,
    /const taskInventoryEnabled = config\.taskInventory\?\.enabled === true;/,
    'src/comm-bridge.js must gate the inventory on `enabled === true`',
  );
  assert.match(bridge, /^if \(taskInventoryEnabled\) \{$/m, 'the reporter must be registered behind the opt-in');
  assert.match(
    bridge,
    /^if \(taskInventoryEnabled\) tasks\.start\('task-inventory'\);$/m,
    'the task must only start behind the opt-in',
  );

  // No leftover upstream-style opt-out gate anywhere in the bridge.
  assert.doesNotMatch(
    bridge,
    /config\.taskInventory\?\.enabled !== false/,
    'upstream opt-out gate came back — the fork makes this feature opt-in',
  );
});

test('fork: DEFAULT_CONFIG.taskInventory.enabled is false', () => {
  const config = read('src/lib/config.js');
  const block = config.match(/taskInventory:\s*\{[^}]*\}/);
  assert.ok(block, 'DEFAULT_CONFIG.taskInventory must be an explicit object');
  assert.match(block[0], /enabled:\s*false/, 'the default must be false in this fork');
});

test('fork: docs say the inventory is off by default', () => {
  const readme = read('README.md');
  assert.match(readme, /\*\*Off by default in this fork\.\*\*/);
  assert.match(readme, /"taskInventory": \{"enabled": true\}/);
  assert.doesNotMatch(readme, /Turn it off with `"taskInventory": \{"enabled": false\}`/);
});
