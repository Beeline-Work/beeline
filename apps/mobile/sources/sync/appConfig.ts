import Constants from 'expo-constants';
import { requireOptionalNativeModule } from 'expo-modules-core';

export interface AppConfig {
    postHogKey?: string;
    consoleLoggingDefault?: boolean;
    buildCommitSha?: string;
    buildCommitTimestamp?: string;
    releaseVersion?: string;
    releaseSha?: string;
    buzzyRelayUrl?: string;
    buzzyPushGatewayUrl?: string;
}

/**
 * Loads app configuration from various manifest sources.
 * Looks for the "app" field in expoConfig.extra across different manifests
 * and merges them into a single configuration object.
 * 
 * Priority (later overrides earlier):
 * 1. ExponentConstants native module manifest (fetches embedded manifest)
 * 2. Constants.expoConfig
 */
export function loadAppConfig(): AppConfig {
    const config: Partial<AppConfig> = {};

    try {
        // 1. Try ExponentConstants native module directly
        const ExponentConstants = requireOptionalNativeModule('ExponentConstants');
        if (ExponentConstants && ExponentConstants.manifest) {
            let exponentManifest = ExponentConstants.manifest;

            // On Android, manifest is passed as JSON string
            if (typeof exponentManifest === 'string') {
                try {
                    exponentManifest = JSON.parse(exponentManifest);
                } catch (e) {
                    console.warn('[loadAppConfig] Failed to parse ExponentConstants.manifest:', e);
                }
            }

            // Look for app config in various locations
            const appConfig = exponentManifest?.extra?.app;
            if (appConfig && typeof appConfig === 'object') {
                Object.assign(config, appConfig);
                console.log('[loadAppConfig] Loaded from ExponentConstants:', Object.keys(config));
            }
        }
    } catch (e) {
        console.warn('[loadAppConfig] Error accessing ExponentConstants:', e);
    }

    try {
        // 2. Try Constants.expoConfig
        if (Constants.expoConfig?.extra?.app) {
            const appConfig = Constants.expoConfig.extra.app;
            if (typeof appConfig === 'object') {
                Object.assign(config, appConfig);
                console.log('[loadAppConfig] Loaded from Constants.expoConfig:', Object.keys(config));
            }
        }
    } catch (e) {
        console.warn('[loadAppConfig] Error accessing Constants.expoConfig:', e);
    }

    console.log('[loadAppConfig] Final merged config:', JSON.stringify(config, null, 2));

    // Override with EXPO_PUBLIC_* env vars if present at runtime and different
    // Why: Native config is baked at prebuild time, but EXPO_PUBLIC_* vars
    // are available at runtime via process.env. This allows devs to change
    // keys without rebuilding native code.
    if (process.env.EXPO_PUBLIC_POSTHOG_KEY && config.postHogKey !== process.env.EXPO_PUBLIC_POSTHOG_KEY) {
        console.log('[loadAppConfig] Override postHogKey from EXPO_PUBLIC_POSTHOG_KEY');
        config.postHogKey = process.env.EXPO_PUBLIC_POSTHOG_KEY;
    }
    if (process.env.EXPO_PUBLIC_BUZZY_RELAY_URL && config.buzzyRelayUrl !== process.env.EXPO_PUBLIC_BUZZY_RELAY_URL) {
        console.log('[loadAppConfig] Override buzzyRelayUrl from EXPO_PUBLIC_BUZZY_RELAY_URL');
        config.buzzyRelayUrl = process.env.EXPO_PUBLIC_BUZZY_RELAY_URL;
    }
    if (process.env.EXPO_PUBLIC_BUZZY_PUSH_GATEWAY_URL && config.buzzyPushGatewayUrl !== process.env.EXPO_PUBLIC_BUZZY_PUSH_GATEWAY_URL) {
        console.log('[loadAppConfig] Override buzzyPushGatewayUrl from EXPO_PUBLIC_BUZZY_PUSH_GATEWAY_URL');
        config.buzzyPushGatewayUrl = process.env.EXPO_PUBLIC_BUZZY_PUSH_GATEWAY_URL;
    }
    if (process.env.EXPO_PUBLIC_BEELINE_RELEASE_VERSION) {
        config.releaseVersion = process.env.EXPO_PUBLIC_BEELINE_RELEASE_VERSION;
    }
    if (process.env.EXPO_PUBLIC_BEELINE_RELEASE_SHA) {
        config.releaseSha = process.env.EXPO_PUBLIC_BEELINE_RELEASE_SHA;
    }
    return config as AppConfig;
}
