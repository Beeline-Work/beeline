import { installWebChunkRecovery, recoverWebChunk } from './web-chunk-recovery';
import * as Sentry from '@sentry/react-native';
import { createErrorEventFilter } from '@beeline/api-contract/error-reporting';
import { funnelScreenFromSegments } from '@beeline/api-contract/signin-funnel';

const filterErrorEvent = createErrorEventFilter();

installWebChunkRecovery();

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
    beforeSend(event, hint) {
      if (recoverWebChunk(hint?.originalException) || event.exception?.values?.some((exception) =>
        exception.stacktrace?.frames?.some((frame) => recoverWebChunk({ filename: frame.filename, name: exception.type, message: exception.value })),
      )) return null;
      return filterErrorEvent(event);
    },
    initialScope: { tags: { surface: 'mobile' } },
  }); } catch { /* Diagnostics must never prevent the app from rendering. */ }
}

/** Expo Router segments retain [parameter] placeholders; never pass a pathname. */
export function setMobileErrorRoute(segments: readonly string[]): void {
  try { Sentry.setTag('route_pattern', funnelScreenFromSegments(segments) ?? undefined); }
  catch { /* Diagnostics must never interrupt navigation. */ }
}

/** Called alongside the existing authenticated diagnostics; recovery never waits on Sentry. */
export function captureMobileError(scope: string, cause: unknown): void {
  if (cause instanceof Error && (
    cause.message === 'Update Beeline from the App Store to use Conversation mode.' ||
    cause.message === 'Update Beeline in the App Store to join calls.' ||
    cause.message === 'Update Beeline from the Play Store to join calls.'
  )) return;
  try { Sentry.captureException(cause, { tags: { surface: 'mobile', error_scope: scope } }); }
  catch { /* Keep the visible failure and Retry available. */ }
}
