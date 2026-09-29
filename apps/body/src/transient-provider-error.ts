/**
 * Conservative text/status heuristic for a provider/harness condition that is
 * expected to clear on its own — a rate limit, an overload, a timeout, a
 * dropped connection — as opposed to a genuine configuration problem (an
 * unknown model id, a harness that holds no credential at all). No ACP
 * contract change: this reads only the same error text every caller already
 * has (`model-config.ts`'s model-selection setter).
 */
const TRANSIENT_PATTERNS = [
  /\b429\b/,
  /\b529\b/,
  /overloaded/i,
  /rate.?limit/i,
  /\bETIMEDOUT\b/,
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /timed out/i,
  /\btimeout\b/i,
];

export function isTransientProviderText(text: string): boolean {
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text));
}
