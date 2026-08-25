import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

test('C4 reply documentation requires stdin message delivery', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
  const assetOps = fs.readFileSync(path.join(ROOT, 'references', 'as-operations.md'), 'utf8');

  assert.match(skill, /pipe the complete reply body via stdin/i);
  assert.doesNotMatch(assetOps, /c4-send\.js openmax "<conv>" "\[MEDIA:image\]\/path"/);
  assert.match(assetOps, /printf '%s\\n'.*\| node .*c4-send\.js/s);
});
