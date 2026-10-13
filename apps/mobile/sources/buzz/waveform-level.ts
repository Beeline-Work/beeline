// Source units come from expo-speech-recognition 3.1.3 and LiveKit.
// Keep display gain fixed so syllables retain their relative loudness.
const DISPLAY_FLOOR_DB = -50;
const DISPLAY_CEILING_DB = -15;
const PERCEPTUAL_EXPONENT = 1;
const SOURCE_FLOOR_DB = -60;
const SOURCE_CEILING_DB = 0;
const IOS_VOLUME_MIN = -2;
const IOS_VOLUME_MAX = 10;
const ANDROID_RMS_MIN_DB = -2;
const ANDROID_RMS_MAX_DB = 10;
const ATTACK_WEIGHT = 0.7;
const RELEASE_WEIGHT = 0.5;

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
  // expo-speech-recognition iOS scales -60..0 dBFS to -2..10.
  // Android forwards recognizer-relative RMS dB without that scaling. Use a
  // package-documented -2..10 event envelope, not the old assumed -2..30.
  // Android RMS is recognizer-relative, not calibrated dBFS; this conversion
  // sets display gain and does not claim identical microphone calibration.
  const min = platform === 'android' ? ANDROID_RMS_MIN_DB : IOS_VOLUME_MIN;
  const max = platform === 'android' ? ANDROID_RMS_MAX_DB : IOS_VOLUME_MAX;
  const db = SOURCE_FLOOR_DB + (value - min) / (max - min) * (SOURCE_CEILING_DB - SOURCE_FLOOR_DB);
  return waveformLevelFromDb(db);
}

/** One 120 ms display sample: responsive attack, brief release. */
export function smoothWaveformLevel(previous: number, next: number): number {
  return previous + (next - previous) * (next > previous ? ATTACK_WEIGHT : RELEASE_WEIGHT);
}
