import * as Sentry from '@sentry/node';
import { createErrorEventFilter } from '@beeline/api-contract/error-reporting';

const filterErrorEvent = createErrorEventFilter();

// The release builder supplies the public ingestion DSN. Runtime env can override or disable it.
declare const BEELINE_BUILD_SENTRY_DSN: string | undefined;
declare const BEELINE_BUILD_SENTRY_RELEASE: string | undefined;
const builtDsn = typeof BEELINE_BUILD_SENTRY_DSN === 'undefined' ? '' : BEELINE_BUILD_SENTRY_DSN;
const builtRelease = typeof BEELINE_BUILD_SENTRY_RELEASE === 'undefined' ? undefined : BEELINE_BUILD_SENTRY_RELEASE;
const dsn = process.env.BEELINE_SENTRY_DSN ?? builtDsn;
if (dsn) {
  try { Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? 'production',
    release: process.env.BEELINE_RELEASE_SHA ?? builtRelease,
    sendDefaultPii: false,
    defaultIntegrations: false,
    // Drain fatal reports before Node's normal exit(1); defer to any existing
    // uncaught-exception handler. Unhandled-rejection policy stays with the app.
    integrations: [Sentry.onUncaughtExceptionIntegration({ exitEvenIfOtherHandlersAreRegistered: false })],
    skipOpenTelemetrySetup: true,
    sampleRate: 1,
    maxBreadcrumbs: 0,
    beforeSend: filterErrorEvent,
    initialScope: { tags: { surface: 'helper' } },
  }); } catch { /* Telemetry configuration must not prevent startup. */ }
}

export function captureHelperError(error: unknown): void {
  if (error instanceof Error && error.message === 'emulator requires -avd <name>') return;
  try { Sentry.captureException(error, { tags: { surface: 'helper' } }); }
  catch { /* Existing logging/retry/exit behavior remains authoritative. */ }
}

export async function flushHelperErrors(): Promise<void> {
  try { await Sentry.flush(2000); } catch { /* Never block exit indefinitely. */ }
}
