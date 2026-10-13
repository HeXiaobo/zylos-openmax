/**
 * Agent activity visibility — shared constants.
 *
 * agent_run schema v2: cws-comm and cws-fe no longer validate content (cws-comm
 * only checks object / ≤ 16 KiB / agent sender; cws-fe renders generically).
 * The enums and the two allowlists below are therefore openmax-internal, and
 * the allowlists are the privacy gate: only names listed here ever leave the
 * host (as step tags). Maintain them here only.
 */

export const SCHEMA_VERSION = 2;

export const STATES = Object.freeze(['queued', 'thinking', 'tool', 'done', 'failed']);

export const CATEGORIES = Object.freeze([
  'command', 'read', 'write', 'search', 'web', 'image',
  'delegate', 'waiting', 'tool', 'kb', 'reply',
]);

export const NOTICE_CODES = Object.freeze(['merged_turn', 'focus_acquired', 'truncated']);

/** Public tool names (frame event `tool`). Anything else is not sent. */
export const TOOL_ALLOWLIST = new Set([
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob',
  'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill', 'TodoWrite', 'exec_command',
  'apply_patch', 'view_image', 'read_file', 'web_search_call', 'tool_search_call',
]);

/** Program names (frame event `detail`): first word of a command, basename only. */
export const DETAIL_ALLOWLIST = new Set([
  'node', 'npm', 'npx', 'pnpm', 'python', 'python3', 'rg', 'cat', 'sed',
  'ls', 'git', 'gh', 'curl', 'jq', 'bash', 'sh',
]);

export const RUN_ID_RE = /^r_[0-9a-f]{8}$/;
export const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const SOURCE_MESSAGE_ID_RE = /^[0-9]{1,19}$/;

// ── collector ──────────────────────────────────────────────────────────────
export const POLL_INTERVAL_MS = 750;
export const DISCOVERY_INTERVAL_MS = 5_000;
export const DISCOVERY_RETRY_MS = 60_000;
export const READ_CHUNK_BYTES = 1024 * 1024;          // ≤ 1 MiB per file per tick
export const MAX_LINE_BYTES = 4 * 1024 * 1024;        // a longer line is skipped
export const INITIAL_TAIL_BYTES = 2 * 1024 * 1024;    // first look at a log: last 2 MiB
export const MAX_TRACKED_LOGS = 4;
export const DISCOVERY_SLACK_MS = 5_000;
export const UUID_LRU_SIZE = 2_000;
export const MAX_CONSECUTIVE_PARSE_FAILURES = 100;
export const INPUT_HEAD_CHARS = 120;
export const SPILL_READ_BYTES = 8 * 1024;
export const CODEX_SQLITE_TIMEOUT_MS = 1_500;

// ── attribution ────────────────────────────────────────────────────────────
export const NO_REPLY_GRACE_MS = 120_000;
export const RUNTIME_RESTART_IDLE_MS = 120_000;
// A started run (it entered a runtime turn) with no attributed event for this
// long ends failed / interrupted. An idle cap, not a total-duration cap: every
// attributed event resets it.
export const ACTIVE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
// A run that never entered a runtime turn (still 'created' / 'queued') ends
// done / no_reply this long after it was registered.
export const QUEUED_NO_START_TIMEOUT_MS = 5 * 60 * 1000;
export const RUN_FILE_RETENTION_MS = 24 * 60 * 60 * 1000;

// ── emitter ────────────────────────────────────────────────────────────────
export const EMIT_TICK_MS = 250;
export const MERGE_WINDOW_MS = 500;
export const HEARTBEAT_MS = 10_000;
export const TTL_MS = 30_000;
export const MAX_FRAME_EVENTS = 50;                  // steps per frame (server cap 50)
export const MAX_FRAME_BYTES = 15_360;                // server cap 16,384
export const MAX_PENDING_EVENTS = 500;
export const MAX_CONCURRENT_RUNS = 50;
export const MAX_DROPPED = 1_000_000;
export const PROBE_CONFIRM_MS = 2_000;
export const FORBIDDEN_LOCAL_ONLY_AFTER = 10;

// ── text ───────────────────────────────────────────────────────────────────
export const TEXT_LIMIT = 2_000;                      // step body
export const TITLE_LIMIT = 80;                        // step / run title, subtitle
export const TAG_LIMIT = 32;                          // one tag
export const MAX_TAGS = 4;
export const STEP_ID_LIMIT = 32;
export const MAX_STEPS = 500;
export const DESCRIPTION_LIMIT = 80;
export const AGENT_RUN_LOCAL_BUDGET = 15 * 1024;      // JSON of agent_run itself; server cap 16,384

export const THROTTLED_LOG_INTERVAL_MS = 10_000;
