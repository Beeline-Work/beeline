type DeviceLocale = { languageTag?: string | null };

const FALLBACK_SPEECH_LOCALE = 'en-US';

/** Pick the first complete BCP-47 language tag the device reports. */
export function speechLocaleFromDeviceLocales(locales: readonly DeviceLocale[]): string {
  for (const locale of locales) {
    const languageTag = locale.languageTag?.trim();
    if (languageTag) return languageTag;
  }
  return FALLBACK_SPEECH_LOCALE;
}

/**
 * Speech recognition follows the device's spoken-language locale. Keep the
 * dependency lazy so an older native binary cannot take the composer down if
 * its Expo localization module is missing.
 */
export function getDeviceSpeechLocale(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const localization = require('expo-localization') as { getLocales?(): DeviceLocale[] };
    return speechLocaleFromDeviceLocales(localization.getLocales?.() ?? []);
  } catch {
    return FALLBACK_SPEECH_LOCALE;
  }
}
