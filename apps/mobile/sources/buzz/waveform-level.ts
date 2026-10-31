// Source units come from expo-speech-recognition 3.1.3 and LiveKit.
// Keep display gain fixed so syllables retain their relative loudness.
const DISPLAY_FLOOR_DB = -50;
const DISPLAY_CEILING_DB = -15;
const PERCEPTUAL_EXPONENT = 1;
const SOURCE_FLOOR_DB = -60;
const SOURCE_CEILING_DB = 0;
const IOS_VOLUME_MIN = -2;
const IOS_VOLUME_MAX = 10;
// R1 Google recognizer captures reach 10 even on normal syllable peaks.
// Leave headroom above those peaks; zero and negative readings are silence.
// Evidence: apps/mobile/evidence/android-dictation-rms/README.md.
const ANDROID_RMS_DISPLAY_CEILING = 12;

/** Fixed display range in dBFS; no per-take gain or peak normalization. */
export function waveformLevelFromDb(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const fraction = Math.max(0, Math.min(1,
    (db - DISPLAY_FLOOR_DB) / (DISPLAY_CEILING_DB - DISPLAY_FLOOR_DB)));
  return Math.pow(fraction, PERCEPTUAL_EXPONENT);
}

/** LiveKit reports linear audio amplitude, not a fraction of display height. */
export function voiceWaveformLevel(amplitude: number): number {
  return waveformLevelFromDb(20 * Math.log10(amplitude));
}

export function dictationWaveformLevel(value: number, platform: string): number {
  if (platform === 'android') {
    if (!Number.isFinite(value)) return 0;
    // Android forwards recognizer-relative RMS, not iOS's scaled dBFS.
    // Applying the dBFS display window again clips ordinary syllables at 7.
    return Math.max(0, Math.min(1, value / ANDROID_RMS_DISPLAY_CEILING));
  }
  // expo-speech-recognition iOS scales -60..0 dBFS to -2..10.
  const db = SOURCE_FLOOR_DB + (value - IOS_VOLUME_MIN) / (IOS_VOLUME_MAX - IOS_VOLUME_MIN)
    * (SOURCE_CEILING_DB - SOURCE_FLOOR_DB);
  return waveformLevelFromDb(db);
}
