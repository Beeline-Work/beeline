/** Only known causes reach chat or the Workbench; provider payloads may hold secrets. */
export function squireReachCause(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/broker unavailable/i.test(message)) return 'Squire broker unavailable';
  if (/ECONNREFUSED/.test(message) || (error instanceof Error &&
      (error.cause as { code?: string } | undefined)?.code === 'ECONNREFUSED'))
    return 'Squire relay connection refused';
  if (/timed out|timeout/i.test(message) || (error instanceof Error && error.name === 'TimeoutError'))
    return 'Squire MCP request timed out';
  if (/connection died|server exited|session closed/i.test(message)) return 'Squire MCP connection closed';
  if (/vault locked/i.test(message)) return 'Squire vault locked';
  const code = message.match(/\b(ENOENT|EACCES|EPERM|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EPIPE)\b/)
    ?? (error instanceof Error ? String((error.cause as { code?: string } | undefined)?.code ?? '')
      .match(/^(ENOENT|EACCES|EPERM|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EPIPE)$/) : null);
  if (code) return `Squire MCP request failed (${code[1]})`;
  if (/no vault metadata/i.test(message) || error instanceof SyntaxError) return 'Squire returned invalid vault metadata';
  const http = message.match(/^Squire relay HTTP (\d{3})$/);
  if (http) return `Squire relay HTTP ${http[1]}`;
  return error instanceof TypeError ? 'Squire relay request failed (TypeError)' : 'Squire MCP tool error';
}
