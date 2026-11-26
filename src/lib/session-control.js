import fs from 'node:fs';
import path from 'node:path';
import { execFile as defaultExecFile } from 'node:child_process';

export function readCoreSettings(home = process.env.HOME || '') {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'zylos/.zylos/config.json'), 'utf8'));
  } catch {
    return null;
  }
}

const TARGET_REQUIRED = /^(?:Error[: ]\s*)?(?:\[CONTROL_TARGET_REQUIRED\]|CONTROL_TARGET_REQUIRED)(?:\s*:|\s*$)/;

// Core adds a namespace for inbound messages, but control argv needs the full
// group. Migrated single-session Core accepts only origin.
export async function enqueueControl(content, {
  execFile = defaultExecFile, nodeBin = process.execPath, controlPath, group,
  readSettings = readCoreSettings, label = 'control', log = () => {}, warn = () => {},
}) {
  const run = (target) => new Promise((resolve) => {
    const args = [controlPath, 'enqueue', '--content', content, '--priority', '2', '--no-ack-suffix'];
    if (target) args.push('--group', target);
    try {
      execFile(nodeBin, args, { timeout: 10_000 }, (error, _stdout, stderr) => {
        const message = String(stderr || '').trim();
        resolve(error ? {
          message: message || `enqueue failed (${error.code ?? 'unknown'})`,
          targetRequired: !error.killed && !error.signal && TARGET_REQUIRED.test(message),
        } : null);
      });
    } catch (error) {
      resolve({ message: `enqueue could not start (${error.code ?? 'unknown'})` });
    }
  });

  const settings = readSettings();
  const target = settings && Object.hasOwn(settings, 'session_mode')
    ? (settings.session_mode === 'single' ? 'origin' : group) : undefined;
  let error = await run(target);
  // A mode transition can require a group before config is updated. This
  // rejection guarantees nothing was queued. Never replay timeouts or unknowns.
  if (!target && group && error?.targetRequired) {
    const mode = readSettings()?.session_mode;
    error = await run(mode === 'single' ? 'origin' : group);
  }
  if (error) warn(`failed to enqueue ${label} control: ${error.message}`);
  else log(`${label} control enqueued (delivery unconfirmed)`);
  return error === null;
}
