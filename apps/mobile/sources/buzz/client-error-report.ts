export type ClientErrorScope = 'conversation' | 'voice-join' | 'voice-cleanup' | 'app' | 'native-crash';

export type NativeCrashReport = {
  id: string; timestamp: number; message: string; stack: string; device: string; platformVersion: string;
  appVersion: string; releaseSha: string; runtimeVersion: string; updateId: string;
};

/** Keep credentials and URL query strings out of diagnostics and server logs. */
export function errorDiagnostic(cause: unknown, stackLines = 6): { message: string; stack: string } {
  const redact = (value: string) => value
    .replace(/https?:\/\/[^\s)]+/gi, '[url]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[token]');
  // WebRTC permission rejections can be plain { name, message } objects.
  const error = cause && typeof cause === 'object' ? cause as { message?: unknown; name?: unknown; stack?: unknown } : null;
  const message = typeof error?.message === 'string' && error.message ? error.message
    : typeof error?.name === 'string' ? error.name
    : typeof cause === 'string' ? cause : 'Conversation mode could not connect';
  return {
    message: redact(message).slice(0, 2048),
    stack: redact(typeof error?.stack === 'string' ? error.stack : '').split('\n').slice(0, stackLines).join('\n').slice(0, 4096),
  };
}

/** Best effort, loaded only after failure; reporting must never break recovery. */
export async function reportClientError(scope: ClientErrorScope, cause: unknown): Promise<void> {
  await sendClientError(scope, cause);
}

/** Acknowledge the native receipt only after an authenticated successful response. */
export async function reportNativeCrash(report: NativeCrashReport): Promise<boolean> {
  return sendClientError('native-crash', report, report);
}

async function sendClientError(scope: ClientErrorScope, cause: unknown, native?: NativeCrashReport): Promise<boolean> {
  try {
    const [{ monolithSession }, { getBuzzRuntimeConfig }, { Platform }, { loadAppConfig }, updates] = await Promise.all([
      import('@/auth/monolith-session'), import('./runtime-config'), import('react-native'), import('@/sync/appConfig'), import('expo-updates'),
    ]);
    const config = loadAppConfig();
    const response = await monolithSession.fetch(`${getBuzzRuntimeConfig().monolithUrl}/v1/phone/observations/client-error`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope, ...errorDiagnostic(cause, native ? 64 : 6), platform: Platform.OS,
        platformVersion: native?.platformVersion ?? String(Platform.Version ?? ''), releaseSha: native?.releaseSha ?? config.releaseSha ?? config.buildCommitSha ?? '',
        runtimeVersion: native?.runtimeVersion ?? updates.runtimeVersion ?? '', updateId: native?.updateId ?? updates.updateId ?? '',
        ...(native ? { device: native.device, appVersion: native.appVersion, crashTimestamp: String(native.timestamp) } : {}) }),
    }, { timeoutMs: 5000 });
    return response.ok;
  } catch { return false; /* The visible error and Retry do not depend on telemetry. */ }
}
