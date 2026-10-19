/**
 * Agent activity visibility — shared constants.
 *
 * agent_run schema v3 (taskboard #137 v4): cws-comm and cws-fe do not
 * validate display content (cws-comm checks the frame envelope, and only
 * object / ≤ 16 KiB / agent sender for the stored summary). openmax is the
 * only place that decides what is shown and the only privacy gate (see
 * privacy.js). The enums below are the display contract with cws-fe: fixed UI
 * wording is never sent — the FE maps `category`, `wait_for`, note `code` and
 * `end_reason` keys to its own (i18n) text.
 */

export const SCHEMA_VERSION = 3;

/** Frame envelope states (cws-comm enum). v3 producers send queued → thinking → done | failed. */
export const STATES = Object.freeze(['queued', 'thinking', 'tool', 'done', 'failed']);

/** Display categories of a tool step (FE: icon + process-group title). */
export const CATEGORIES = Object.freeze([
  'command', 'read', 'write', 'edit', 'search_files', 'search_web', 'fetch_web',
  'image', 'delegate', 'kb', 'skill', 'tool',
]);

/**
 * Internal-only categories: a reply send and a wait / poll call are never
 * steps and never counted (decision 6).
 */
export const HIDDEN_CATEGORIES = Object.freeze(['reply', 'waiting']);

/** wait_for keys (running tool step, no real progress): FE maps to text. */
export const WAIT_FOR = Object.freeze({
  command: 'command_result',
  search_web: 'search_results',
  fetch_web: 'page_response',
  delegate: 'subagent_result',
  kb: 'kb_result',
  skill: 'tool_result',
  tool: 'tool_result',
});

/** Note codes. Only merged_turn comes from a run; steps_omitted from compaction. */
export const NOTE_CODES = Object.freeze(['merged_turn', 'steps_omitted']);

/** Run end reasons (summary / terminal frame). */
export const END_REASONS = Object.freeze(['runtime_restarted', 'interrupted', 'no_reply']);

export const DETAIL_TYPES = Object.freeze(['text', 'links', 'output', 'diff', 'children']);

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

// ── text / display caps (plan §3.2 / §3.3) ─────────────────────────────────
export const TEXT_LIMIT = 2_000;                      // thinking body
export const TITLE_LIMIT = 60;                        // step title
export const OBJECT_LIMIT = 60;                       // step object
export const WAIT_FOR_LIMIT = 40;
export const STEP_ID_LIMIT = 32;
export const MAX_STEPS = 500;
export const MAX_STEP_COUNT = 10_000;
export const DETAIL_TEXT_LIMIT = 500;                 // detail.text (code points)
export const LINKS_MAX_ITEMS = 8;
export const LINK_TITLE_LIMIT = 80;
export const LINK_URL_LIMIT = 200;
export const DIFF_PREVIEW_LINES = 40;
export const DIFF_PREVIEW_BYTES = 2 * 1024;
export const CHILDREN_MAX_ITEMS = 10;
export const FRAME_DETAIL_BYTES = 4 * 1024;           // one step's detail on a live frame
export const THINKING_COMPACT_LIMIT = 200;            // compaction level 3
export const AGENT_RUN_LOCAL_BUDGET = 15 * 1024;      // JSON of agent_run itself; server cap 16,384

export const THROTTLED_LOG_INTERVAL_MS = 10_000;
