import { FUNNEL_SCREENS } from './signin-funnel.js';

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
  // Reuse the finite screen allowlist. Filled paths and arbitrary route names
  // must not bypass the privacy boundary, even if supplied by an SDK scope.
  if (typeof tags.route_pattern === 'string' && FUNNEL_SCREENS.includes(tags.route_pattern as never))
    (output.tags as Record<string, unknown>).route_pattern = tags.route_pattern;
  // No user, IP, device identity, request, breadcrumbs, extra, source lines,
  // locals, attachments, arbitrary contexts/tags, session replay, or log payloads.
  return output as T;
}

const ERROR_REPORT_WINDOW_MS = 60 * 60 * 1000;
const ERROR_REPORT_HOURLY_CEILING = 100;

/** One instance per SDK/process. Admission happens after privacy filtering, including SDK fatal events. */
export function createErrorEventFilter(now: () => number = Date.now): <T>(input: T) => T | null {
  const reported = new Map<string, number>();
  return <T>(input: T): T | null => {
    const event = privateErrorEvent(input);
    const time = now();
    for (const [key, at] of reported) {
      if (time - at >= ERROR_REPORT_WINDOW_MS) reported.delete(key);
    }
    const data = object(event);
    const exceptions = object(data.exception).values;
    const normalize = (value: unknown) => String(value ?? '').replace(/\d+/g, '#');
    const fingerprint = JSON.stringify(Array.isArray(exceptions) && exceptions.length
      ? exceptions.map(value => {
        const exception = object(value);
        return [String(exception.type ?? 'Error'), normalize(exception.value)];
      })
      : [['Message', normalize(data.message)]]);
    // Only accepted fingerprints enter the map, bounding memory even in a novel-error loop.
    if (reported.has(fingerprint) || reported.size >= ERROR_REPORT_HOURLY_CEILING) return null;
    reported.set(fingerprint, time);
    return event;
  };
}
