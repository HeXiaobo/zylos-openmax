/**
 * Agent online self-report — onboarding trigger signal (cws-core C1).
 *
 * Once per process per org, tell cws-core this agent instance is up:
 * POST /api/v1/agents/{member_id}/online-report. cws-core uses the report as
 * its onboarding trigger signal, gated entirely server-side (platform switch,
 * org's-first-active-agent check, session state) — so repeated reports across
 * restarts are expected input, not errors. A failed report never affects
 * messaging: callers retry on the next WS (re)connect and on the periodic
 * sync tick until one attempt succeeds.
 *
 * Deps are injected so the report logic is unit-testable without the
 * comm-bridge daemon (see online-report.test.js).
 */

export function createOnlineReporter({ loadConfig, postForOrg, apiPath, log, warn }) {
  const done = new Set();     // org slugs reported (or permanently skipped) this process
  const inflight = new Set(); // guard against a reconnect racing an in-flight POST

  async function reportAgentOnline(orgConfig) {
    if (done.has(orgConfig.slug) || inflight.has(orgConfig.slug)) return;

    let memberId = orgConfig.self?.member_id;
    if (!memberId) {
      // Fresh install: the first token exchange writes member_id back through
      // updateConfig, which clones and replaces the config object — the
      // boot-captured orgConfig never sees it, and watchConfig treats `self`
      // as structural (restart-only). Re-resolve from the live config, which
      // updateConfig refreshes in-process, and fill the captured object in
      // place so later reads are consistent.
      memberId = loadConfig().orgs?.[orgConfig.slug]?.self?.member_id || '';
      if (!memberId) return; // write-back hasn't landed yet — retried on reconnect / periodic sync
      orgConfig.self = { ...(orgConfig.self || {}), member_id: memberId };
    }

    inflight.add(orgConfig.slug);
    try {
      const res = await postForOrg(
        orgConfig.org_id,
        apiPath(`/agents/${memberId}/online-report`),
        undefined,
        { quietOnSuccess: true },
      );
      done.add(orgConfig.slug);
      // Only log the meaningful event (an actual onboarding trigger). The routine
      // triggered=false summary fires every reconnect/periodic tick and floods
      // out.log, so it is suppressed.
      if (res?.triggered === true) {
        log(`[${orgConfig.slug}] online-report: triggered=true${res?.reason ? ` reason=${res.reason}` : ''}`);
      }
    } catch (err) {
      if (err?.status === 404) {
        // Endpoint not on this cws-core (older deployment) — mirror
        // syncConfigToComm: warn once and stop retrying for the process.
        done.add(orgConfig.slug);
        warn(`[${orgConfig.slug}] online-report endpoint not available (404), skipping`);
        return;
      }
      throw err;
    } finally {
      inflight.delete(orgConfig.slug);
    }
  }

  // Exposed so a caller that does expensive work *before* calling us (e.g. the
  // readiness gate, which can poll for minutes) can skip that work entirely
  // once this org has nothing left to report. Without this the gate would wait
  // on a reconnect only to reach a no-op.
  reportAgentOnline.isDone = (slug) => done.has(slug);

  return reportAgentOnline;
}
