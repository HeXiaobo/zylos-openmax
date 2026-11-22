#!/usr/bin/env node
/**
 * Print the in-group session name for an OpenMax reply endpoint. zylos-core
 * (multi-session mode) runs this for every outbound `c4-send openmax` and for
 * scheduler tasks; an older Core never calls it.
 *
 * Usage: node scripts/session-group.js <endpoint>
 * Success: group name (dm-<id> / group-<id> / sub-<id>, without the `openmax:`
 * namespace) on stdout, exit 0.
 * An endpoint with `|type:` is mapped directly (no file, no network). Anything
 * else (a bare conversation id, a legacy `[OPENMAX DM|GROUP]/` prefix, a legacy
 * thread endpoint whose thread part is ignored) is resolved by the
 * conversation's stored type (conv-org-map.json) or, on a miss,
 * GET /conversations/{id} (~4s budget, under Core's 5s query limit).
 * Wrong arguments, an endpoint that cannot be mapped, a type with no session
 * group (STRAT, BROADCAST, BRIDGE) or a failed lookup: message on stderr,
 * nothing on stdout, exit 1 (never guessed). Core then sends and records
 * nothing.
 */
import { resolveSessionGroup } from '../src/lib/session-group.js';

// stdout carries only the group name (Core reads it). Route any console output
// from the HTTP client to stderr.
console.log = console.info = console.debug = (...args) => console.error(...args);

const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error('Usage: node scripts/session-group.js <endpoint>');
  process.exit(1);
}
try {
  const name = await resolveSessionGroup(args[0], {
    onLegacyThread: () => console.error('[openmax] session-group: DEPRECATED legacy thread endpoint, the thread part is ignored (refused from openmax 2.36.0)'),
  });
  process.stdout.write(`${name}\n`);
  // Exit explicitly: the HTTP client may keep sockets or timers alive.
  process.exit(0);
} catch (err) {
  console.error(`[openmax] session-group: ${err.message}`);
  process.exit(1);
}
