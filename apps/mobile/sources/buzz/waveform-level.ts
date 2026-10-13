/** Fixed display range in dBFS; no per-take gain or peak normalization. */
export function waveformLevelFromDb(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const fraction = Math.max(0, Math.min(1, (db + 50) / 45));
  return Math.pow(fraction, 1.5);
}

/** LiveKit reports linear audio amplitude, not a fraction of display height. */
export function voiceWaveformLevel(amplitude: number): number {
  return waveformLevelFromDb(20 * Math.log10(amplitude));
}

export function dictationWaveformLevel(value: number, platform: string): number {
  // expo-speech-recognition iOS scales -60..0 dBFS to -2..10.
  // Android forwards recognizer-relative RMS dB without that scaling. Use a
  // fixed -2..30 envelope; recognizer/device calibration is not standardized.
  const db = platform === 'android'
    ? -60 + (value + 2) * (60 / 32)
    : -60 + (value + 2) * 5;
  return waveformLevelFromDb(db);
}

/** One 120 ms display sample: responsive attack, brief release. */
export function smoothWaveformLevel(previous: number, next: number): number {
  return previous + (next - previous) * (next > previous ? 0.7 : 0.5);
}
