/** Shared privacy boundary for external error reporting. Never ship request or Room content. */
export function redactDiagnostic(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)]+/gi, '[url]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[token]')
    .replace(/\b(?:sk-|sk_|ghp_|github_pat_|sntrys_|sntryu_)[\w-]+/g, '[token]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(?:\/home\/|\/Users\/)[^/\s]+/g, '[home]');
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};

/** Allowlist, rather than blacklist, data Sentry integrations may add in future. */
export function privateErrorEvent<T>(input: T): T {
  const event = object(input);
  const output: Record<string, unknown> = {};
  for (const key of ['event_id', 'timestamp', 'platform', 'level', 'release', 'environment', 'sdk', 'debug_meta']) {
    if (event[key] !== undefined) output[key] = event[key];
  }
  const exceptions = object(event.exception).values;
  if (Array.isArray(exceptions)) output.exception = { values: exceptions.slice(-8).map(value => {
    const exception = object(value);
    const frames = object(exception.stacktrace).frames;
    return {
      type: redactDiagnostic(String(exception.type ?? 'Error')).slice(0, 128),
      value: redactDiagnostic(String(exception.value ?? 'Unknown error')).slice(0, 2048),
      ...(exception.mechanism ? { mechanism: {
        type: String(object(exception.mechanism).type ?? 'generic'),
        handled: object(exception.mechanism).handled !== false,
      } } : {}),
      ...(Array.isArray(frames) ? { stacktrace: { frames: frames.slice(-64).map(value => {
        const frame = object(value);
        const result: Record<string, unknown> = {};
        for (const key of ['filename', 'function', 'module']) {
          if (typeof frame[key] === 'string') result[key] = redactDiagnostic(frame[key] as string).slice(0, 512);
        }
        for (const key of ['lineno', 'colno', 'in_app']) if (frame[key] !== undefined) result[key] = frame[key];
        return result;
      }) } } : {}),
    };
  }) };
  if (typeof event.message === 'string') output.message = redactDiagnostic(event.message).slice(0, 2048);
  const tags = object(event.tags);
  output.tags = Object.fromEntries(['surface', 'error_scope', 'background_job'].filter(key =>
    typeof tags[key] === 'string' && /^[a-z0-9_-]{1,64}$/i.test(tags[key] as string),
  ).map(key => [key, tags[key]]));
  // No user, IP, device identity, request, breadcrumbs, extra, source lines,
  // locals, attachments, arbitrary contexts/tags, session replay, or log payloads.
  return output as T;
}
