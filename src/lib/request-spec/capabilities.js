/**
 * Client-capability negotiation for request_spec actions (plan §7.1).
 *
 * The plugin advertises what it can execute on every catalog-type request
 * (X-Connect-Client-Capabilities). cws-connect hides actions whose
 * request_spec.requires is not covered, so an older plugin never sees them;
 * the local check below is the second line of defence against a stale cache
 * or a version skew.
 */
import { specError } from './errors.js';

/** Spec-version marker: the plugin understands request_spec version 1. */
export const REQUEST_SPEC_VERSION_CAPABILITY = 'request_spec.v1';

/** Feature capabilities a request_spec may list in `requires`. */
export const FEATURE_CAPABILITIES = Object.freeze([
  'body_template', 'prefetch', 'file_source', 'file_upload', 'resumable_upload', 'batch',
]);

/** Everything this plugin build supports (spec marker + features). */
export const SUPPORTED_CAPABILITIES = Object.freeze([REQUEST_SPEC_VERSION_CAPABILITY, ...FEATURE_CAPABILITIES]);

export const CAPABILITIES_HEADER_NAME = 'X-Connect-Client-Capabilities';

/** Header value sent on catalog requests; also the local catalog cache signature. */
export const CAPABILITIES_HEADER_VALUE = SUPPORTED_CAPABILITIES.join(', ');

/** Request headers to attach to a catalog-type cws-core call. */
export function capabilityHeaders() {
  return { [CAPABILITIES_HEADER_NAME]: CAPABILITIES_HEADER_VALUE };
}

/**
 * Refuse (426) an action whose `requires` names a capability this plugin does
 * not implement. Runs before any network call.
 */
export function assertCapabilities(requires, supported = SUPPORTED_CAPABILITIES) {
  const have = new Set(supported);
  const missing = (Array.isArray(requires) ? requires : []).filter((c) => !have.has(c));
  if (missing.length) {
    throw specError(426, `action requires plugin capabilities [${missing.join(', ')}]; upgrade the openmax plugin`,
      { missing_capabilities: missing });
  }
}
