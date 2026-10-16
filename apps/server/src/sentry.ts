import * as Sentry from '@sentry/node';
import { privateErrorEvent } from '@beeline/api-contract/error-reporting';

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
    beforeSend: privateErrorEvent,
    initialScope: { tags: { surface: 'server' } },
  }); } catch { /* Telemetry configuration must not prevent startup. */ }
}

export function captureServerError(error: unknown, tags: Record<string, string> = {}): void {
  try { Sentry.captureException(error, { tags: { surface: 'server', ...tags } }); }
  catch { /* Reporting must never change the original failure path. */ }
}

export async function flushServerErrors(): Promise<void> {
  try { await Sentry.flush(2000); } catch { /* Shutdown stays bounded. */ }
}
