import { ExpectedRefusalError } from './command-refusal.js';
import { GitHubCheckPermissionError, GitHubHttpError } from '@beeline/auth/github';
import * as Sentry from '@sentry/node';
import { createErrorEventFilter, privateErrorEvent } from '@beeline/api-contract/error-reporting';

const filterErrorEvent = createErrorEventFilter();

/** No HTTP/console instrumentation; existing request and background recovery owns handled failures. */
if (process.env.SENTRY_DSN) {
  try { Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? 'production',
    release: process.env.BEELINE_RELEASE_SHA ?? process.env.FLY_IMAGE_REF,
    sendDefaultPii: false,
    defaultIntegrations: false,
    // Drain fatal reports before Node's normal exit(1); defer to any existing
    // uncaught-exception handler. Unhandled-rejection policy stays with the app.
    integrations: [Sentry.onUncaughtExceptionIntegration({ exitEvenIfOtherHandlersAreRegistered: false })],
    skipOpenTelemetrySetup: true,
    sampleRate: 1,
    maxBreadcrumbs: 0,
    beforeSend: event => {
      if (event.tags?.error_scope !== 'slow_query') return filterErrorEvent(event);
      // Report every completed slow query, grouped by its parameter-free SQL
      // fingerprint, while retaining the shared privacy boundary.
      const filtered = privateErrorEvent(event);
      if (event.fingerprint?.length === 2 && event.fingerprint[0] === 'slow-query' &&
          /^[a-f0-9]{16}$/.test(event.fingerprint[1]!)) filtered.fingerprint = event.fingerprint;
      return filtered;
    },
    initialScope: { tags: { surface: 'server' } },
  }); } catch { /* Telemetry configuration must not prevent startup. */ }
}

export function captureServerError(error: unknown, tags: Record<string, string> = {}): void {
  if (error instanceof ExpectedRefusalError) return;
  if (error instanceof GitHubCheckPermissionError) return;
  if (error instanceof GitHubHttpError && error.rateLimited) return;
  try { Sentry.captureException(error, { tags: { surface: 'server', ...tags } }); }
  catch { /* Reporting must never change the original failure path. */ }
}

export async function flushServerErrors(): Promise<void> {
  try { await Sentry.flush(2000); } catch { /* Shutdown stays bounded. */ }
}

/** Completed-query alert only; telemetry never changes database execution. */
export function captureSlowQuery(fingerprint: string, durationMs: number, sqlPreview: string, code: unknown): void {
  if (!process.env.SENTRY_DSN || (process.env.SENTRY_ENVIRONMENT ?? 'production') !== 'production') return;
  // SQL is authored by the server, but literals may be interpolated. Keep the
  // structure and parameter placeholders; never send literal values to Sentry.
  const preview = sqlPreview.replace(/'(?:[^']|'')*(?:'|$)/g, "'?'");
  try {
    // The shared privacy filter retains messages, not arbitrary extra fields.
    Sentry.captureMessage(`Slow database query ${fingerprint}: ${Math.round(durationMs)} ms${typeof code === 'string' ? ` (${code})` : ''}; ${preview}`, {
      level: 'warning', fingerprint: ['slow-query', fingerprint],
      tags: { surface: 'server', error_scope: 'slow_query' },
    });
  } catch { /* Telemetry must not turn a committed query into a failure. */ }
}
