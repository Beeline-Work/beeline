import Constants from 'expo-constants';

export interface AppConfig {
  postHogKey?: string;
  consoleLoggingDefault?: boolean;
  buildCommitSha?: string;
  buildCommitTimestamp?: string;
  releaseVersion?: string;
  releaseSha?: string;
  buzzyMonolithUrl?: string;
}

let sessionConfig: AppConfig | undefined;

/**
 * Loads app configuration from the embedded manifest once per app session.
 * Later opens reuse that object. A Room open used to read and print it again
 * from every call site.
 *
 * Priority (later overrides earlier), applied on that single read:
 * 1. Constants.expoConfig (embedded and OTA manifests)
 * 2. Monolith URL and release SHA overrides present at startup
 */
export function loadAppConfig(): AppConfig {
  if (sessionConfig) return sessionConfig;
  const config: Partial<AppConfig> = {};

  try {
    const appConfig = Constants.expoConfig?.extra?.app;
    if (appConfig && typeof appConfig === 'object') Object.assign(config, appConfig);
  } catch (e) {
    console.warn('[loadAppConfig] Error accessing Constants.expoConfig:', e);
  }

  // app.config owns provider keys and release version in both embedded and OTA
  // manifests. Keep the dev-server URL and diagnostics SHA overrides here.
  if (process.env.EXPO_PUBLIC_BUZZY_MONOLITH_URL) {
    config.buzzyMonolithUrl = process.env.EXPO_PUBLIC_BUZZY_MONOLITH_URL;
  }
  if (process.env.EXPO_PUBLIC_BEELINE_RELEASE_SHA) {
    config.releaseSha = process.env.EXPO_PUBLIC_BEELINE_RELEASE_SHA;
  }
  sessionConfig = config as AppConfig;
  return sessionConfig;
}
