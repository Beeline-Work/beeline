/**
 * Network-class failure detection, kept dependency-free so the standalone
 * read-only MCP bundle can import it without pulling in `ws` and the rest of
 * the live-link machinery.
 */

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ECONNABORTED',
]);

/**
 * Whether a failure carries a network-class code anywhere in its cause chain
 * (or is an AggregateError made only of such failures). A response the server
 * actually sent is never one of these.
 */
export function isNetworkFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string' && (NETWORK_ERROR_CODES.has(code) || code.startsWith('UND_ERR_')))
      return true;
    if (value instanceof AggregateError && value.errors.length > 0 && value.errors.every(visit))
      return true;
    return visit((value as { cause?: unknown }).cause);
  };
  return visit(error);
}