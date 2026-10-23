/**
 * Error helper shared by the request_spec engine: every failure carries an HTTP
 * `status` the CLI surfaces as-is (400 caller error, 413 too large, 422 bad
 * spec, 426 plugin too old).
 */
export function specError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}
