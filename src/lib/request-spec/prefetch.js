/**
 * Read-only prefetch (plan §5.5): up to 3 sequential GET calls of actions in
 * the SAME catalog, whose normalized results ({status_code, headers, body})
 * become `prefetch.<as>` in the body template (e.g. the original message a
 * reply quotes). Results live only in memory for this invocation and are never
 * logged. Any non-2xx aborts the invocation: that response is returned as-is
 * with failed_step "prefetch:<as>".
 */
import { specError } from './errors.js';
import { evalTemplate, evalCondition, isMissing } from './template.js';

/**
 * steps: spec.prefetch; params: caller params; catalog: action array;
 * runGet(actionDef, params) → normalized response (auth + refresh handled by caller).
 * Returns { results } or { failed: response }.
 */
export async function runPrefetch(steps, { params, catalog, files = {} }, runGet) {
  const results = {};
  for (const step of steps || []) {
    const ctx = { params, prefetch: results, files };
    if (step.when !== undefined && !evalCondition(step.when, ctx)) continue;
    const def = Array.isArray(catalog) ? catalog.find((a) => `${a.toolkit}/${a.action}` === step.action) : null;
    if (!def) throw specError(422, `request_spec: prefetch action "${step.action}" is not in the local catalog`);
    if (String(def.method || 'GET').toUpperCase() !== 'GET') throw specError(422, `request_spec: prefetch action "${step.action}" is not a GET action`);
    if (def.request_spec) throw specError(422, `request_spec: prefetch action "${step.action}" must not have a request_spec`);
    const p = evalTemplate(step.params, ctx);
    const stepParams = isMissing(p) ? {} : p;
    const res = await runGet(def, stepParams);
    if (!res || res.status_code < 200 || res.status_code >= 300) {
      return { failed: { ...res, failed_step: `prefetch:${step.as}` } };
    }
    results[step.as] = { status_code: res.status_code, headers: res.headers || {}, body: res.body };
  }
  return { results };
}
