import * as Sentry from '@sentry/react-native';
import { privateErrorEvent } from '@beeline/api-contract/error-reporting';

if (process.env.EXPO_PUBLIC_SENTRY_DSN && !__DEV__) {
  try { Sentry.init({
    dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
    environment: 'production',
    release: process.env.EXPO_PUBLIC_BEELINE_RELEASE_SHA,
    sendDefaultPii: false,
    // Native receipts already survive process death. This works on existing
    // store binaries through OTA without introducing another native handler.
    enableNative: false,
    patchGlobalPromise: false,
    sampleRate: 1,
    maxBreadcrumbs: 0,
    enableAutoSessionTracking: false,
    enableNativeNagger: false,
    enableAutoPerformanceTracing: false,
    enableAppStartTracking: false,
    enableNativeFramesTracking: false,
    enableWatchdogTerminationTracking: false,
    enableCaptureFailedRequests: false,
    attachScreenshot: false,
    attachViewHierarchy: false,
    beforeSend: privateErrorEvent,
    initialScope: { tags: { surface: 'mobile' } },
  }); } catch { /* Diagnostics must never prevent the app from rendering. */ }
}

/** Called alongside the existing authenticated diagnostics; recovery never waits on Sentry. */
export function captureMobileError(scope: string, cause: unknown): void {
  if (cause instanceof Error && (
    cause.message === 'Update Beeline from the App Store to use Conversation mode.' ||
    cause.message === 'Update Beeline in the App Store to join calls.'
  )) return;
  try { Sentry.captureException(cause, { tags: { surface: 'mobile', error_scope: scope } }); }
  catch { /* Keep the visible failure and Retry available. */ }
}
